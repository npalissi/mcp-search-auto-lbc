import { execSync } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LeboncoinSearchParams, LeboncoinAd } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL = "https://api.leboncoin.fr/finder/search";
const HOMEPAGE_URL = "https://www.leboncoin.fr/";
const CATEGORY_VOITURES = "2";

// Cached Python executable path (resolved at first use)
let cachedPythonPath: string | null = null;

/**
 * Find and cache the working Python 3.11 executable path.
 * Tries full paths first (more reliable in server context), then relies on PATH.
 */
function getPythonPath(): string {
  if (cachedPythonPath) {
    return cachedPythonPath;
  }

  const pythonPaths = [
    "/opt/homebrew/bin/python3.11", // First: try macOS homebrew full path
    "/usr/local/bin/python3.11",    // Second: try common Unix path
    "python3.11",                   // Third: rely on PATH (may fail in server context)
    "/opt/homebrew/bin/python3",    // Fallback: any version from homebrew
    "/usr/local/bin/python3",       // Fallback: any version from Unix
    "python3",                      // Last resort: rely on PATH
  ];

  for (const py of pythonPaths) {
    try {
      // Test if the path works by running a simple version check
      execSync(`${py} --version`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      });
      cachedPythonPath = py;
      // stdout is reserved for MCP stdio transports; diagnostics go to stderr.
      console.error(`[LBC] Using Python: ${py}`);
      return py;
    } catch {
      // Continue to next path
    }
  }

  throw new Error("Python 3.11 not found in any standard path");
}

// Fuel & gearbox mappings (natural values → LBC codes)
const FUEL_MAP: Record<string, string> = {
  "hybride rechargeable": "8",
  "hybrid rechargeable": "8",
  phev: "8",
  essence: "1",
  diesel: "2",
  gpl: "3",
  electrique: "4",
  électrique: "4",
  hybride: "6",
  hybrid: "6",
};

const GEARBOX_MAP: Record<string, string> = {
  manuelle: "1",
  automatique: "2",
};

// ---------------------------------------------------------------------------
// User-Agent — mimics LBC mobile app (same pattern as Python lbc lib)
// ---------------------------------------------------------------------------

function generateUserAgent(): string {
  const isIos = Math.random() > 0.5;
  if (isIos) {
    const versions = ["18.5", "18.6", "18.7", "26.0", "26.1", "26.2"];
    const appVersions = ["101.45.0", "101.44.0", "101.43.1", "101.42.0"];
    const osVersion = versions[Math.floor(Math.random() * versions.length)];
    const appVersion = appVersions[Math.floor(Math.random() * appVersions.length)];
    const deviceId = crypto.randomUUID();
    return `LBC;iOS;${osVersion};iPhone;phone;${deviceId};wifi;${appVersion}`;
  } else {
    const osVersions = ["11", "12", "13", "14", "15"];
    const models = ["SM-G991B", "Pixel 7", "Pixel 8", "Redmi Note 12", "OnePlus 9"];
    const appVersions = ["100.85.2", "100.84.1", "100.83.1"];
    const osVersion = osVersions[Math.floor(Math.random() * osVersions.length)];
    const model = models[Math.floor(Math.random() * models.length)];
    const appVersion = appVersions[Math.floor(Math.random() * appVersions.length)];
    const deviceId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return `LBC;Android;${osVersion};${model};phone;${deviceId};wifi;${appVersion}`;
  }
}

// ---------------------------------------------------------------------------
// Build search payload
// ---------------------------------------------------------------------------

function buildSearchPayload(params: LeboncoinSearchParams) {
  const enums: Record<string, string[]> = {
    ad_type: ["offer"],
  };

  // Exact marketplace identifiers when supplied by the caller/catalogue.
  if (params.lbcBrand) enums.u_car_brand = [params.lbcBrand];
  if (params.lbcModel) enums.u_car_model = [params.lbcModel];

  // Keep readable brand/model keywords as a fallback and relevance signal.
  if (params.fuel) enums.fuel = [params.fuel];
  if (params.gearbox) enums.gearbox = [params.gearbox];

  const searchText = [params.brand, params.model].filter(Boolean).join(" ");

  const ranges: Record<string, { min?: number; max?: number }> = {};

  if (params.priceMin !== undefined || params.priceMax !== undefined) {
    ranges.price = {};
    if (params.priceMin !== undefined) ranges.price.min = params.priceMin;
    if (params.priceMax !== undefined) ranges.price.max = params.priceMax;
  }

  if (params.mileageMin !== undefined || params.mileageMax !== undefined) {
    ranges.mileage = {};
    if (params.mileageMin !== undefined) ranges.mileage.min = params.mileageMin;
    if (params.mileageMax !== undefined) ranges.mileage.max = params.mileageMax;
  }

  if (params.yearMin !== undefined || params.yearMax !== undefined) {
    ranges.regdate = {};
    if (params.yearMin !== undefined) ranges.regdate.min = params.yearMin;
    if (params.yearMax !== undefined) ranges.regdate.max = params.yearMax;
  }

  return {
    filters: {
      category: { id: CATEGORY_VOITURES },
      enums,
      ranges,
      keywords: { text: searchText },
    },
    limit: 35,
    limit_alu: 3,
    offset: 0,
    sort_by: "time",
    sort_order: "desc",
  };
}

// ---------------------------------------------------------------------------
// Parse response
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseAds(raw: any): LeboncoinAd[] {
  const ads: any[] = raw?.ads ?? [];

  return ads
    .filter((ad: any) => ad.price?.[0] != null)
    .map((ad: any) => {
      const attrs = ad.attributes ?? [];
      const getAttr = (key: string): string | undefined =>
        attrs.find((a: any) => a.key === key)?.value;
      const attributes = Object.fromEntries(
        attrs
          .filter((attribute: any) => attribute?.key && attribute?.value != null)
          .map((attribute: any) => [attribute.key, attribute.value]),
      );
      const images = Array.from(
        new Set<string>(
          [
            ...(ad.images?.urls_large ?? []),
            ...(ad.images?.urls ?? []),
            ad.images?.thumb_url,
          ].filter((image): image is string => typeof image === "string" && image.length > 0),
        ),
      );
      const description =
        typeof ad.body === "string" ? ad.body : ad.body?.text ?? undefined;

      const price = ad.price[0]; // LBC price is in euros (integer)

      return {
        id: ad.list_id ?? ad.store_id ?? 0,
        title: ad.subject ?? "",
        price,
        url: ad.url ?? `https://www.leboncoin.fr/voitures/${ad.list_id}.htm`,
        mileage: getAttr("mileage") ? parseInt(getAttr("mileage")!, 10) : undefined,
        year: getAttr("regdate") ? parseInt(getAttr("regdate")!, 10) : undefined,
        fuel: getAttr("fuel"),
        location: ad.location?.city ?? ad.location?.department_name ?? undefined,
        lat: ad.location?.lat ?? undefined,
        lng: ad.location?.lng ?? undefined,
        department: ad.location?.department_name ?? undefined,
        zipcode: ad.location?.zipcode ?? undefined,
        image: images[0],
        images,
        description,
        sellerType: ad.owner?.type ?? getAttr("owner_type"),
        attributes,
      };
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search Leboncoin for vehicle ads.
 * Mimics the LBC mobile app User-Agent to avoid Datadome blocks.
 * First GETs the homepage to init cookies, then POSTs the search.
 */
export async function searchLeboncoin(
  params: LeboncoinSearchParams,
): Promise<LeboncoinAd[]> {
  const ua = generateUserAgent();

  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json",
    "Content-Type": "application/json",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    Origin: "https://www.leboncoin.fr",
    Referer: "https://www.leboncoin.fr/",
  };

  // Step 1: GET homepage for cookies (like the Python lib does)
  let cookieString = "";
  try {
    const homeRes = await fetch(HOMEPAGE_URL, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept: "text/html",
      },
      redirect: "follow",
    });

    const setCookies = homeRes.headers.getSetCookie?.() ?? [];
    const cookies: string[] = [];
    for (const sc of setCookies) {
      const pair = sc.split(";")[0]!;
      cookies.push(pair);
    }
    cookieString = cookies.join("; ");
  } catch {
    // Continue without cookies — might still work
  }

  // Step 2: POST search
  const payload = buildSearchPayload(params);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      ...headers,
      ...(cookieString ? { Cookie: cookieString } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Leboncoin API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return parseAds(data);
}

/**
 * Helpers to convert natural fuel/gearbox strings to LBC codes.
 */
export function fuelToLbcCode(fuel: string): string | undefined {
  const lower = fuel.toLowerCase();
  // Direct match first
  if (FUEL_MAP[lower]) return FUEL_MAP[lower];
  // Fuzzy match — "Essence" → "1", "Diesel (Gasoil)" → "2", etc.
  for (const [key, code] of Object.entries(FUEL_MAP)) {
    if (lower.includes(key)) return code;
  }
  return undefined;
}

export function gearboxToLbcCode(gearbox: string): string | undefined {
  const lower = gearbox.toLowerCase();
  if (GEARBOX_MAP[lower]) return GEARBOX_MAP[lower];
  // Fuzzy — "Boite de vitesse manuelle" → "1", "Automatique / Séquentielle" → "2"
  if (lower.includes("manuelle") || lower.includes("manual")) return "1";
  if (lower.includes("automatique") || lower.includes("auto")) return "2";
  return undefined;
}

/**
 * Extract base model name — "208 1.2 PureTech Like" → "208"
 * LBC model filter only accepts the base model, not the sub-type.
 *
 * Patterns: "208" | "Clio" | "Serie 3" | "Classe A" | "C3" | "Golf"
 * Sub-types to strip: "1.2 PureTech Like", "1.5 dCi", "TDI 150"
 */
export function normalizeModel(model: string): string {
  // Split on common sub-type separators
  // "208 1.2 PureTech Like" → take "208" (before the version number)
  // "Serie 3 320d" → take "Serie 3"
  // "Classe A 180" → take "Classe A"

  // First: strip everything after a version pattern like "1.2", "2.0", "1.5"
  const beforeVersion = model.split(/\s+\d+\.\d+/)[0]!.trim();
  if (beforeVersion && beforeVersion !== model) {
    return beforeVersion;
  }

  // Fallback: take just the first word
  return model.split(/\s+/)[0] ?? model;
}

// ---------------------------------------------------------------------------
// Python bridge — uses installed `lbc` lib (curl_cffi) to bypass Datadome
// ---------------------------------------------------------------------------

const PYTHON_SEARCH_SCRIPT = `
import json, sys
from lbc import Client

args = json.loads(sys.argv[1])
client = Client()

# Build raw payload directly (bypasses lib's kwargs validation)
enums = {"ad_type": ["offer"]}
# Exact marketplace identifiers when available, plus text fallback.
search_text = " ".join(filter(None, [args.get("brand"), args.get("model")]))
if args.get("lbcBrand"): enums["u_car_brand"] = [args["lbcBrand"]]
if args.get("lbcModel"): enums["u_car_model"] = [args["lbcModel"]]
if args.get("fuel"): enums["fuel"] = [args["fuel"]]
if args.get("gearbox"): enums["gearbox"] = [args["gearbox"]]

ranges = {}
if args.get("priceMin") or args.get("priceMax"):
    ranges["price"] = {}
    if args.get("priceMin"): ranges["price"]["min"] = args["priceMin"]
    if args.get("priceMax"): ranges["price"]["max"] = args["priceMax"]
if args.get("mileageMin") or args.get("mileageMax"):
    ranges["mileage"] = {}
    if args.get("mileageMin"): ranges["mileage"]["min"] = args["mileageMin"]
    if args.get("mileageMax"): ranges["mileage"]["max"] = args["mileageMax"]
if args.get("yearMin") or args.get("yearMax"):
    ranges["regdate"] = {}
    if args.get("yearMin"): ranges["regdate"]["min"] = args["yearMin"]
    if args.get("yearMax"): ranges["regdate"]["max"] = args["yearMax"]

all_ads = []
MAX_PAGES = int(args.get("maxPages") or 5)

for page in range(MAX_PAGES):
    payload = {
        "filters": {
            "category": {"id": "2"},
            "enums": enums,
            "ranges": ranges,
            "keywords": {"text": search_text},
        },
        "limit": 35,
        "limit_alu": 3,
        "offset": page * 35,
        "sort_by": "time",
        "sort_order": "desc",
    }

    body = client._fetch(method="POST", url="https://api.leboncoin.fr/finder/search", payload=payload)
    page_ads = body.get("ads", [])

    if not page_ads:
        break

    for ad in page_ads:
        if not ad.get("price") or not ad["price"]:
            continue
        attrs = {a["key"]: a.get("value") for a in ad.get("attributes", [])}
        price = ad["price"][0] if isinstance(ad["price"], list) else ad["price"]
        loc = ad.get("location", {})
        images_data = ad.get("images", {}) or {}
        images = list(dict.fromkeys(
            (images_data.get("urls_large") or []) +
            (images_data.get("urls") or []) +
            ([images_data.get("thumb_url")] if images_data.get("thumb_url") else [])
        ))
        body = ad.get("body")
        description = body if isinstance(body, str) else (body or {}).get("text")
        all_ads.append({
            "id": ad.get("list_id", 0),
            "title": ad.get("subject", ""),
            "price": price,
            "url": ad.get("url", ""),
            "mileage": int(attrs["mileage"]) if attrs.get("mileage") else None,
            "year": int(attrs["regdate"]) if attrs.get("regdate") else None,
            "fuel": attrs.get("fuel"),
            "location": loc.get("city"),
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
            "department": loc.get("department_name"),
            "zipcode": loc.get("zipcode"),
            "image": images[0] if images else None,
            "images": images,
            "description": description,
            "sellerType": (ad.get("owner") or {}).get("type") or attrs.get("owner_type"),
            "attributes": attrs,
        })

    if len(page_ads) < 35:
        break

print(json.dumps(all_ads))
`;

/**
 * Search Leboncoin via the Python `lbc` library (uses curl_cffi to bypass Datadome).
 * Falls back to this when native fetch gets 403.
 */
export function searchLeboncoinViaPython(
  params: LeboncoinSearchParams,
): LeboncoinAd[] {
  const argsJson = JSON.stringify({
    brand: params.brand,
    model: params.model,
    lbcBrand: params.lbcBrand,
    lbcModel: params.lbcModel,
    yearMin: params.yearMin,
    yearMax: params.yearMax,
    mileageMin: params.mileageMin,
    mileageMax: params.mileageMax,
    fuel: params.fuel,
    gearbox: params.gearbox,
    priceMin: params.priceMin,
    priceMax: params.priceMax,
    maxPages: Math.max(
      1,
      params.maxPages ?? Number(process.env.LBC_MAX_PAGES ?? 5),
    ),
  });

  // Write Python script to a temp file (python3 -c chokes on multiline)
  const dir = mkdtempSync(join(tmpdir(), "lbc-"));
  const scriptPath = join(dir, "search.py");
  const argsPath = join(dir, "args.json");

  try {
    writeFileSync(argsPath, argsJson);
    writeFileSync(scriptPath, PYTHON_SEARCH_SCRIPT.replace("sys.argv[1]", `open("${argsPath}").read()`));

    // Get the cached Python path (resolved at first call)
    const py = getPythonPath();

    try {
      const result = execSync(`${py} "${scriptPath}"`, {
        encoding: "utf-8",
        timeout: 30000,
        // Descriptions and full image lists make multi-page MCP responses much
        // larger than the compact payload historically used by the web app.
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
      });

      const ads: LeboncoinAd[] = JSON.parse(result.trim());
      return ads;
    } catch (e: unknown) {
      // execSync throws on non-zero exit — capture stdout+stderr from the error
      if (e && typeof e === "object" && "stdout" in e) {
        const stdout = String((e as { stdout: unknown }).stdout).trim();
        if (stdout.startsWith("[")) {
          // The script may have succeeded but exited non-zero due to stderr
          const ads: LeboncoinAd[] = JSON.parse(stdout.trim());
          return ads;
        }
      }
      if (e && typeof e === "object" && "stderr" in e) {
        const stderr = String((e as { stderr: unknown }).stderr).trim();
        if (stderr) console.error("[LBC PY ERROR]", stderr);
      }
      throw e;
    }
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
    try { unlinkSync(argsPath); } catch { /* ignore */ }
  }
}
