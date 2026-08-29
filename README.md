# MCP Search Auto LBC

An MCP server that estimates used-car market values from comparable Leboncoin
listings. It gives the model each retained listing's title, description, raw
attributes, images, price, and URL, along with the reasons why other listings
were excluded.

## Endpoints

- Local MCP endpoint: `http://127.0.0.1:3100/mcp`
- Health check: `http://127.0.0.1:3100/health`
- Suggested production endpoint: `https://mcp.your-domain.com/mcp`

The server uses the **MCP Streamable HTTP** transport. `POST /mcp` accepts MCP
JSON-RPC messages. `GET /mcp` and `DELETE /mcp` intentionally return HTTP 405
because the server operates without sessions.

## Installation

Requirements: Node.js 20 or newer and Python 3.11. All Leboncoin network traffic
goes through a persistent Python worker backed by `lbc`; the TypeScript process
only exposes MCP and computes the valuation. By default the worker pairs
curl_cffi's `chrome_android` TLS profile with a matching Leboncoin Android
User-Agent so Datadome sees one coherent client fingerprint. Both `lbc` and
`curl-cffi` are pinned to the versions covered by the live integration test.

```bash
npm install
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm start
```

The server then exposes `http://127.0.0.1:3100/mcp`.

On Windows, install the Python dependencies with
`.venv\Scripts\python.exe -m pip install -r requirements.txt`.

## Commands

```bash
npm start
npm run dev
npm test
npm run typecheck
```

Available environment variables:

- `MCP_HOST`: defaults to `127.0.0.1`
- `MCP_PORT`: defaults to `3100`
- `MCP_API_TOKEN`: required Bearer token when listening outside localhost
- `MCP_ALLOWED_HOSTS`: comma-separated list of allowed hostnames
- `LBC_PYTHON_PATH`: explicit path to a Python executable with `lbc>=1.1.5`
- `LBC_MAX_PAGES`: maximum number of pages fetched per search; defaults to `3`
- `LBC_PAGE_DELAY_MS`: base delay between pages; defaults to `1500` ms and
  includes randomized jitter
- `LBC_MAX_RETRIES`: Datadome retries inside the Python client; defaults to `1`
- `LBC_REQUEST_TIMEOUT_SECONDS`: timeout for each Python HTTP request; defaults
  to `30`
- `LBC_WORKER_TIMEOUT_MS`: maximum duration of a complete worker search;
  defaults to `90000`
- `LBC_PROXY_URL`: optional proxy URL, including credentials when required
- `LBC_IMPERSONATE`: optional browser profile supported by `curl_cffi`;
  defaults to the tested `chrome_android` profile
- `LBC_CATALOG_CACHE_SECONDS`: lifetime of the Leboncoin brand/model/trim
  catalog cache; defaults to 24 hours
- `LBC_CATALOG_CACHE_PATH`: catalog cache file; defaults to
  `.cache/leboncoin-vehicle-catalog.json`
- `VALUATION_CACHE_TTL_MS`: in-memory cache lifetime; defaults to 15 minutes

## Tool: `resolve_leboncoin_vehicle`

This tool converts natural vehicle names into exact Leboncoin filter IDs. It
first checks the local catalog and can then confirm an unknown model from one
page of live listings.

Example input:

```json
{
  "brand": "Renault",
  "model": "Clio III",
  "fuel": "diesel",
  "engine": "1.5 dCi 90"
}
```

Example output:

```json
{
  "resolved": true,
  "brand": "Renault",
  "model": "Clio",
  "leboncoinBrand": "RENAULT",
  "leboncoinModel": "RENAULT_Clio",
  "generation": "3",
  "fuel": "diesel",
  "leboncoinFuel": "2",
  "confidenceScore": 98,
  "source": "catalog",
  "warnings": [],
  "alternatives": []
}
```

## Tool: `estimate_used_vehicle`

Example input:

```json
{
  "brand": "Renault",
  "model": "Clio",
  "leboncoinBrand": "RENAULT",
  "leboncoinModel": "RENAULT_Clio",
  "generation": "3",
  "year": 2010,
  "mileage": 100000,
  "fuel": "diesel",
  "engine": "1.5 dCi 90",
  "gearbox": "manual",
  "trim": "Dynamique",
  "excludeCompanyVehicles": true,
  "excludeProfessionalSellers": true,
  "location": {
    "city": "Saintes",
    "latitude": 45.746,
    "longitude": -0.633,
    "radiusKm": 200
  },
  "maxComparables": 20,
  "includeDescriptions": true,
  "includeImages": true
}
```

Leboncoin's exact filter IDs are different from the labels displayed to users:

- `u_car_brand`: `RENAULT`, `PEUGEOT`, `BMW`, `MERCEDES-BENZ`, and so on
- `u_car_model`: the brand ID, an underscore, and the case-sensitive model
  label, such as `RENAULT_Clio`, `PEUGEOT_208`, `VOLKSWAGEN_Golf`, or
  `TESLA_Model 3`
- The generation (`Clio 3`) and engine (`1.5 dCi 90`) are not part of
  `u_car_model`; they are checked against the manufacturer version, title,
  attributes, and description.
- Main fuel codes are `1` for petrol, `2` for diesel, `4` for electric, `6`
  for hybrid, and `8` for plug-in hybrid. Gearbox codes are `1` for manual and
  `2` for automatic.

When `leboncoinBrand` or `leboncoinModel` is omitted, the server retains a text
search as a fallback.

Condensed output example:

```json
{
  "request": {},
  "valuation": {
    "estimatedPrice": 5000,
    "lowPrice": 4600,
    "highPrice": 5400,
    "quickSalePrice": 4500,
    "currency": "EUR",
    "confidence": "high",
    "confidenceScore": 82
  },
  "market": {
    "adsFetched": 25,
    "comparablesUsed": 14,
    "excludedCount": 11
  },
  "comparables": [
    {
      "title": "Renault Clio III 1.5 dCi 90",
      "price": 5100,
      "description": "Full listing description...",
      "characteristics": {
        "regdate": "2010",
        "mileage": "103000",
        "fuel": "Diesel"
      },
      "images": ["https://..."],
      "url": "https://www.leboncoin.fr/...",
      "similarityScore": 0.92,
      "matchedCriteria": ["brand", "model", "year", "mileage", "fuel", "engine"]
    }
  ],
  "excludedAds": [
    {
      "title": "Damaged Clio sold for parts",
      "reasons": ["damaged, non-running, or parts-only vehicle"]
    }
  ],
  "warnings": []
}
```

## Live vehicle catalog

Brands and models are synchronized by the Python worker from the same frontend
configuration currently used by Leboncoin. Trims are fetched lazily for a
selected model. The compact catalog is cached locally for 24 hours and a stale
cache remains usable during a temporary upstream failure.

The MCP exposes three targeted tools so an LLM never needs to load the full
catalog into its context:

- `list_leboncoin_vehicle_brands`
- `list_leboncoin_vehicle_models`
- `list_leboncoin_vehicle_trims`

`resolve_leboncoin_vehicle` uses this catalog automatically before falling back
to observed listing attributes. The catalog structure is also published as an
MCP resource at `vehicle://catalog/schema`.

## Connecting an MCP client

The server uses Streamable HTTP. A typical client configuration looks like
this:

```json
{
  "mcpServers": {
    "mcp-search-auto-lbc": {
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

The ready-to-use agent skill is available in
[`skills/leboncoin-vehicle-valuation`](./skills/leboncoin-vehicle-valuation).

## Disclaimer

This project uses an unofficial API and is neither affiliated with nor endorsed
by Leboncoin. A valuation is an estimate based on advertised asking prices, not
a guaranteed appraisal of a vehicle.
