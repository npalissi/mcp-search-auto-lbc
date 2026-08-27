#!/usr/bin/env python3
"""Persistent JSON-lines worker for Leboncoin vehicle searches."""

from __future__ import annotations

import json
import os
import random
import sys
import time
from importlib.metadata import version
from typing import Any
from urllib.parse import unquote, urlparse

import lbc


MINIMUM_LBC_VERSION = (1, 1, 5)
PAGE_SIZE = 35


def parse_version(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in value.split(".") if part.isdigit())


def optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def build_proxy() -> lbc.Proxy | None:
    proxy_url = os.getenv("LBC_PROXY_URL", "").strip()
    if not proxy_url:
        return None
    if "://" not in proxy_url:
        proxy_url = f"http://{proxy_url}"
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


def build_client() -> lbc.Client:
    retries = max(0, int(os.getenv("LBC_MAX_RETRIES", "1")))
    timeout = max(5.0, float(os.getenv("LBC_REQUEST_TIMEOUT_SECONDS", "30")))
    impersonate = os.getenv("LBC_IMPERSONATE", "").strip() or None
    return lbc.Client(
        proxy=build_proxy(),
        impersonate=impersonate,
        timeout=timeout,
        max_retries=retries,
    )


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
            ads = worker.search(request.get("params") or {})
            respond({"id": request_id, "ok": True, "ads": ads})
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
