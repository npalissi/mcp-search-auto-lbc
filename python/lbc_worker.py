#!/usr/bin/env python3
"""Persistent JSON-lines worker for Leboncoin vehicle searches."""

from __future__ import annotations

import json
import os
import random
import sys
import time
import uuid
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import lbc
from curl_cffi import requests


MINIMUM_LBC_VERSION = (1, 1, 5)
PAGE_SIZE = 35
CATALOG_API_BASE = "https://api.leboncoin.fr/api/frontend/v1/data"
DEFAULT_CATALOG_CACHE_SECONDS = 24 * 60 * 60


class MatchedMobileClient(lbc.Client):
    """Use an Android User-Agent matching curl_cffi's Android TLS profile."""

    def _generate_user_agent(self) -> str:
        device_id = uuid.uuid4().hex[:16]
        return (
            "LBC;Android;14;Pixel 7;phone;"
            f"{device_id};wifi;100.85.2"
        )


def parse_version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split(".") if part.isdigit())


def optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def configured_proxy_url() -> str | None:
    proxy_url = os.getenv("LBC_PROXY_URL", "").strip()
    if not proxy_url:
        return None
    if "://" not in proxy_url:
        proxy_url = f"http://{proxy_url}"
    return proxy_url


def build_proxy() -> lbc.Proxy | None:
    proxy_url = configured_proxy_url()
    if not proxy_url:
        return None
    parsed = urlparse(proxy_url)
    if not parsed.hostname or not parsed.port:
        raise ValueError("LBC_PROXY_URL must contain a hostname and port.")
    return lbc.Proxy(
        host=parsed.hostname,
        port=parsed.port,
        username=unquote(parsed.username) if parsed.username else None,
        password=unquote(parsed.password) if parsed.password else None,
        scheme=parsed.scheme or "http",
    )


def build_client() -> MatchedMobileClient:
    retries = max(0, int(os.getenv("LBC_MAX_RETRIES", "1")))
    timeout = max(5.0, float(os.getenv("LBC_REQUEST_TIMEOUT_SECONDS", "30")))
    impersonate = os.getenv("LBC_IMPERSONATE", "").strip() or "chrome_android"
    return MatchedMobileClient(
        proxy=build_proxy(),
        impersonate=impersonate,
        timeout=timeout,
        max_retries=retries,
    )


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def simple_values(feature: Any) -> list[dict[str, str]]:
    if not isinstance(feature, dict):
        return []
    values = feature.get("values")
    if not isinstance(values, dict) or values.get("type") != "simple":
        return []
    result: list[dict[str, str]] = []
    for option in values.get("simpleData") or []:
        if not isinstance(option, dict):
            continue
        value = str(option.get("value") or "").strip()
        label = str(option.get("label") or "").strip()
        if value and label:
            result.append({"value": value, "label": label})
    return result


def grouped_values(feature: Any) -> list[dict[str, str]]:
    if not isinstance(feature, dict):
        return []
    values = feature.get("values")
    if not isinstance(values, dict) or values.get("type") != "grouped":
        return []
    result: list[dict[str, str]] = []
    for group in values.get("groupedData") or []:
        if not isinstance(group, dict):
            continue
        for option in group.get("list") or []:
            if not isinstance(option, dict):
                continue
            value = str(option.get("value") or "").strip()
            label = str(option.get("label") or "").strip()
            if value and label:
                result.append({"value": value, "label": label})
    return result


def build_vehicle_catalog(
    feature_data: dict[str, Any],
    form_data: dict[str, Any],
) -> dict[str, Any]:
    features = feature_data.get("features") or {}
    brands = grouped_values(features.get("u_car_brand"))
    brand_fields = (
        form_data.get("multi", {}).get("u_car_brandFields", {})
    )
    catalog_brands: list[dict[str, Any]] = []

    for brand in brands:
        feature_name: str | None = None
        for item in brand_fields.get(brand["value"], []) or []:
            if isinstance(item, dict) and item.get("type") == "feature":
                feature_name = str(item.get("name") or "") or None
                if feature_name:
                    break
        models = simple_values(features.get(feature_name)) if feature_name else []
        catalog_brands.append({**brand, "models": models})

    return {
        "version": 1,
        "sourceVersion": str(form_data.get("version") or ""),
        "fetchedAt": utc_now(),
        "brands": catalog_brands,
    }


class VehicleCatalogClient:
    def __init__(self) -> None:
        timeout = max(5.0, float(os.getenv("LBC_REQUEST_TIMEOUT_SECONDS", "30")))
        impersonate = os.getenv("LBC_IMPERSONATE", "").strip() or "chrome_android"
        self.session = requests.Session(
            impersonate=impersonate,
            proxy=configured_proxy_url(),
            timeout=timeout,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Referer": "https://www.leboncoin.fr/c/voitures",
            },
        )
        self.cache_seconds = max(
            300,
            int(
                os.getenv(
                    "LBC_CATALOG_CACHE_SECONDS",
                    str(DEFAULT_CATALOG_CACHE_SECONDS),
                )
            ),
        )
        configured_path = os.getenv("LBC_CATALOG_CACHE_PATH", "").strip()
        self.cache_path = Path(
            configured_path or ".cache/leboncoin-vehicle-catalog.json"
        )

    def _read_cache(self) -> dict[str, Any]:
        try:
            value = json.loads(self.cache_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}

    def _write_cache(self, value: dict[str, Any]) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.cache_path.with_suffix(f".{os.getpid()}.tmp")
        temporary_path.write_text(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary_path.replace(self.cache_path)

    def _is_fresh(self, fetched_at: Any) -> bool:
        timestamp = parse_timestamp(fetched_at)
        if not timestamp:
            return False
        return (datetime.now(UTC) - timestamp).total_seconds() < self.cache_seconds

    def get_catalog(self, force_refresh: bool = False) -> dict[str, Any]:
        cache = self._read_cache()
        cached_catalog = cache.get("catalog")
        if (
            not force_refresh
            and isinstance(cached_catalog, dict)
            and self._is_fresh(cached_catalog.get("fetchedAt"))
        ):
            return {**cached_catalog, "cacheStatus": "fresh"}

        try:
            feature_response = self.session.get(f"{CATALOG_API_BASE}/v7/fdata")
            feature_response.raise_for_status()
            form_response = self.session.get(f"{CATALOG_API_BASE}/v5/fforms")
            form_response.raise_for_status()
            catalog = build_vehicle_catalog(
                feature_response.json(),
                form_response.json(),
            )
            self._write_cache(
                {
                    "catalog": catalog,
                    "trims": cache.get("trims") or {},
                }
            )
            return {**catalog, "cacheStatus": "refreshed"}
        except Exception:
            if isinstance(cached_catalog, dict) and cached_catalog.get("brands"):
                return {**cached_catalog, "cacheStatus": "stale"}
            raise

    def get_trims(
        self,
        leboncoin_model: str,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        model = leboncoin_model.strip()
        if not model:
            raise ValueError("leboncoinModel is required.")

        cache = self._read_cache()
        trims = cache.get("trims") if isinstance(cache.get("trims"), dict) else {}
        cached_entry = trims.get(model)
        if (
            not force_refresh
            and isinstance(cached_entry, dict)
            and self._is_fresh(cached_entry.get("fetchedAt"))
        ):
            return {"model": model, **cached_entry, "cacheStatus": "fresh"}

        try:
            response = self.session.post(
                f"{CATALOG_API_BASE}/feature/trim_levels",
                json={"u_car_model": [model]},
            )
            response.raise_for_status()
            values = simple_values(response.json())
            entry = {"fetchedAt": utc_now(), "values": values}
            trims[model] = entry
            self._write_cache(
                {
                    "catalog": cache.get("catalog") or {},
                    "trims": trims,
                }
            )
            return {"model": model, **entry, "cacheStatus": "refreshed"}
        except Exception:
            if isinstance(cached_entry, dict) and cached_entry.get("values"):
                return {"model": model, **cached_entry, "cacheStatus": "stale"}
            raise


def add_enum(filters: dict[str, list[str]], key: str, value: Any) -> None:
    if value is not None and str(value).strip():
        filters[key] = [str(value)]


def add_range(
    filters: dict[str, list[int]],
    key: str,
    minimum: Any,
    maximum: Any,
    default_minimum: int,
    default_maximum: int,
) -> None:
    lower = optional_int(minimum)
    upper = optional_int(maximum)
    if lower is None and upper is None:
        return
    filters[key] = [
        lower if lower is not None else default_minimum,
        upper if upper is not None else default_maximum,
    ]


def owner_type(value: Any) -> lbc.OwnerType | None:
    normalized = str(value or "").lower()
    if normalized == "private":
        return lbc.OwnerType.PRIVATE
    if normalized == "pro":
        return lbc.OwnerType.PRO
    if normalized == "all":
        return lbc.OwnerType.ALL
    return None


def search_location(value: Any) -> lbc.City | None:
    if not isinstance(value, dict):
        return None

    try:
        latitude = float(value["latitude"])
        longitude = float(value["longitude"])
        radius_km = int(value["radiusKm"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "location requires numeric latitude, longitude and radiusKm."
        ) from error

    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("location coordinates are outside their valid ranges.")
    if not 1 <= radius_km <= 200:
        raise ValueError("location radiusKm must be between 1 and 200.")

    city = str(value.get("city") or "").strip() or None
    return lbc.City(
        lat=latitude,
        lng=longitude,
        radius=radius_km * 1_000,
        city=city,
    )


def serialize_ad(ad: lbc.Ad, selected_owner_type: str | None) -> dict[str, Any]:
    attributes = {
        key: attribute.value for key, attribute in (ad.attributes or {}).items()
    }
    images = list(dict.fromkeys(ad.images or []))
    location = ad.location
    mileage = optional_int(attributes.get("mileage"))
    year = optional_int(attributes.get("regdate"))
    return {
        "id": ad.id,
        "title": ad.subject or "",
        "price": ad.price,
        "url": ad.url or f"https://www.leboncoin.fr/ad/voitures/{ad.id}",
        "mileage": mileage,
        "year": year,
        "fuel": attributes.get("fuel"),
        "location": location.city if location else None,
        "lat": location.lat if location else None,
        "lng": location.lng if location else None,
        "department": location.department_name if location else None,
        "zipcode": location.zipcode if location else None,
        "image": images[0] if images else None,
        "images": images,
        "description": ad.body,
        "sellerType": (
            selected_owner_type
            if selected_owner_type in {"private", "pro"}
            else None
        ),
        "attributes": attributes,
    }


class LeboncoinWorker:
    def __init__(self) -> None:
        self.client = build_client()
        self.catalog_client = VehicleCatalogClient()

    def execute(self, action: str, params: dict[str, Any]) -> Any:
        if action == "search":
            return self.search(params)
        if action == "vehicle_catalog":
            return self.catalog_client.get_catalog(
                force_refresh=bool(params.get("forceRefresh")),
            )
        if action == "vehicle_trims":
            return self.catalog_client.get_trims(
                str(params.get("leboncoinModel") or ""),
                force_refresh=bool(params.get("forceRefresh")),
            )
        raise ValueError(f"Unknown worker action: {action}")

    def search(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        enums: dict[str, list[str]] = {}
        ranges: dict[str, list[int]] = {}
        add_enum(enums, "u_car_brand", params.get("lbcBrand"))
        add_enum(enums, "u_car_model", params.get("lbcModel"))
        add_enum(enums, "fuel", params.get("fuel"))
        add_enum(enums, "gearbox", params.get("gearbox"))
        add_range(
            ranges,
            "price",
            params.get("priceMin"),
            params.get("priceMax"),
            0,
            100_000_000,
        )
        add_range(
            ranges,
            "mileage",
            params.get("mileageMin"),
            params.get("mileageMax"),
            0,
            2_000_000,
        )
        add_range(
            ranges,
            "regdate",
            params.get("yearMin"),
            params.get("yearMax"),
            1900,
            2100,
        )

        selected_owner_type = str(params.get("ownerType") or "").lower() or None
        selected_location = search_location(params.get("location"))
        maximum_pages = min(5, max(1, int(params.get("maxPages") or 3)))
        base_delay_ms = max(0, int(os.getenv("LBC_PAGE_DELAY_MS", "1500")))
        search_text = " ".join(
            str(value).strip()
            for value in [params.get("brand"), params.get("model")]
            if value and str(value).strip()
        )

        ads: list[dict[str, Any]] = []
        for page in range(1, maximum_pages + 1):
            if page > 1 and base_delay_ms > 0:
                jitter_ms = random.randint(0, min(750, base_delay_ms))
                time.sleep((base_delay_ms + jitter_ms) / 1000)

            result = self.client.search(
                text=search_text,
                category=lbc.Category.VEHICULES_VOITURES,
                sort=lbc.Sort.NEWEST,
                page=page,
                limit=PAGE_SIZE,
                limit_alu=0,
                ad_type=lbc.AdType.OFFER,
                owner_type=owner_type(selected_owner_type),
                locations=selected_location,
                **enums,
                **ranges,
            )
            page_ads = result.ads or []
            ads.extend(serialize_ad(ad, selected_owner_type) for ad in page_ads)
            if len(page_ads) < PAGE_SIZE:
                break

        return ads


def respond(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> None:
    installed_version = version("lbc")
    if parse_version(installed_version) < MINIMUM_LBC_VERSION:
        raise RuntimeError(
            f"lbc>={'.'.join(map(str, MINIMUM_LBC_VERSION))} is required; "
            f"found {installed_version}."
        )
    print(f"persistent worker ready with lbc {installed_version}", file=sys.stderr)
    worker = LeboncoinWorker()

    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: int | None = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            action = str(request.get("action") or "search")
            result = worker.execute(action, request.get("params") or {})
            respond({"id": request_id, "ok": True, "result": result})
        except Exception as error:  # The error is returned to the MCP caller.
            respond(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "type": type(error).__name__,
                        "message": str(error),
                    },
                }
            )


if __name__ == "__main__":
    main()
