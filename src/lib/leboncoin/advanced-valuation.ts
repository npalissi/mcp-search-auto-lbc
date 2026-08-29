import {
  fuelToLbcCode,
  gearboxToLbcCode,
  searchLeboncoinViaPython,
} from "./client";
import type {
  LeboncoinAd,
  LeboncoinAttributeValue,
  LeboncoinSearchLocation,
} from "./types";
import { resolveLeboncoinVehicleWithDiscovery } from "./resolver";

export type VehicleValuationRequest = {
  brand: string;
  model: string;
  leboncoinBrand?: string;
  leboncoinModel?: string;
  year: number;
  mileage: number;
  generation?: string;
  fuel?: string;
  engine?: string;
  gearbox?: string;
  trim?: string;
  excludeCompanyVehicles?: boolean;
  excludeProfessionalSellers?: boolean;
  location?: LeboncoinSearchLocation;
  maxComparables?: number;
  includeDescriptions?: boolean;
  includeImages?: boolean;
  descriptionMaxChars?: number;
};

export type ComparableAd = {
  id: number;
  title: string;
  price: number;
  url: string;
  year?: number;
  mileage?: number;
  fuel?: string;
  location?: string;
  sellerType?: string;
  description?: string;
  characteristics: Record<string, LeboncoinAttributeValue>;
  images?: string[];
  similarityScore: number;
  matchedCriteria: string[];
  flags: string[];
  yearDifference?: number;
  mileageDifference?: number;
};

export type ExcludedAd = {
  id: number;
  title: string;
  price: number;
  url: string;
  reasons: string[];
};

export type AdvancedVehicleValuation = {
  request: VehicleValuationRequest;
  valuation: {
    estimatedPrice: number;
    lowPrice: number;
    highPrice: number;
    quickSalePrice: number;
    currency: "EUR";
    confidence: "low" | "medium" | "high";
    confidenceScore: number;
    method: string;
  };
  market: {
    adsFetched: number;
    adsAnalyzed: number;
    comparablesUsed: number;
    excludedCount: number;
    medianSimilarity: number;
    priceSpread: number;
    fetchedAt: string;
  };
  comparables: ComparableAd[];
  excludedAds: ExcludedAd[];
  warnings: string[];
};

const DAMAGED_PATTERNS = [
  /accident(?:é|ee?|ée)?/i,
  /sinistr(?:é|ee?|ée)?/i,
  /pour pi[eè]ces/i,
  /pi[eè]ces d[eé]tach[eé]es/i,
  /moteur (?:hs|cass[eé])/i,
  /bo[iî]te (?:hs|cass[eé]e)/i,
  /non roulant/i,
  /ne d[eé]marre pas/i,
  /[àa] r[eé]parer/i,
  /vendue? en l['’][eé]tat/i,
  /sans carte grise/i,
  /probl[eè]me (?:d['’])?injection/i,
  /perte de puissance/i,
  /(?:injecteur|turbo|fap|embrayage|distribution).{0,30}(?:hs|cass[eé]|[àa] (?:faire|changer|remplacer))/i,
  /(?:[àa] (?:faire|changer|remplacer)).{0,30}(?:injecteur|turbo|fap|embrayage|distribution)/i,
];

const FINANCING_PATTERNS = [
  /(?:mensualit[eé]|loyer|cr[eé]dit|financement).{0,30}\b(?:par mois|\/mois|mensuel)/i,
  /(?:apport|premier loyer)/i,
  /\b\d+\s*€?\s*\/\s*mois\b/i,
];

const COMPANY_VEHICLE_PATTERNS = [
  /\baffaire\b/i,
  /\bberline entreprise\b/i,
  /\bv[eé]hicule de soci[eé]t[eé]\b/i,
  /\bversion soci[eé]t[eé]\b/i,
  /\bd[eé]riv[eé] vp\b/i,
  /\b2\s*places?\b/i,
  /\btva r[eé]cup[eé]rable\b/i,
];

const FUEL_ALIASES: Record<string, string[]> = {
  diesel: ["diesel", "gasoil", "dci", "hdi", "tdi", "bluehdi", "crdi", "cdti"],
  essence: ["essence", "puretech", "tsi", "tce", "vti", "mpi", "tfsi"],
  hybride: ["hybride", "hybrid", "hev", "phev"],
  electrique: ["electrique", "electric", "ev"],
  gpl: ["gpl", "lpg"],
};

const valuationCache = new Map<
  string,
  { expiresAt: number; result: AdvancedVehicleValuation }
>();

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function weightedPercentile(
  values: Array<{ price: number; weight: number }>,
  ratio: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a.price - b.price);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const target = totalWeight * ratio;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= target) return item.price;
  }
  return sorted.at(-1)!.price;
}

function textFor(ad: LeboncoinAd): string {
  return normalize(
    [
      ad.title,
      ad.description,
      ...Object.values(ad.attributes ?? {}).map(String),
    ].join(" "),
  );
}

function matchesToken(haystack: string, needle: string | undefined): boolean {
  const normalizedNeedle = normalize(needle);
  return (
    normalizedNeedle.length > 0 &&
    ` ${haystack} `.includes(` ${normalizedNeedle} `)
  );
}

const ROMAN_GENERATIONS: Record<string, string> = {
  "1": "i",
  "2": "ii",
  "3": "iii",
  "4": "iv",
  "5": "v",
  "6": "vi",
  "7": "vii",
  "8": "viii",
};

function generationAliases(generation: string): string[] {
  const normalized = normalize(generation);
  const numeric = Object.entries(ROMAN_GENERATIONS).find(
    ([number, roman]) => normalized === number || normalized === roman,
  );
  return numeric ? numeric : [normalized];
}

function generationText(ad: LeboncoinAd): string {
  return normalize(
    [
      ad.title,
      ad.attributes?.model,
      ad.attributes?.u_car_model,
      ad.description?.slice(0, 350),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function generationMatches(ad: LeboncoinAd, generation: string): boolean {
  const haystack = generationText(ad);
  return generationAliases(generation).some((alias) => matchesToken(haystack, alias));
}

function explicitlyDifferentGeneration(
  ad: LeboncoinAd,
  request: VehicleValuationRequest,
): boolean {
  if (!request.generation) return false;
  const haystack = generationText(ad);
  const model = normalize(request.model).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = haystack.match(
    // Do not interpret the displacement in "208 1.5 BlueHDi" as generation 1.
    new RegExp(
      `\\b${model}\\s+(i{1,3}|iv|v(?:i{0,3})?|[1-8](?![\\d.,]|\\s+\\d))\\b`,
    ),
  );
  return Boolean(match && !generationAliases(request.generation).includes(match[1]!));
}

function fuelMatches(ad: LeboncoinAd, requestedFuel: string): boolean {
  const requested = normalize(requestedFuel);
  const adFuel = normalize(ad.fuel);
  const fullText = textFor(ad);
  const group = Object.entries(FUEL_ALIASES).find(
    ([canonical, aliases]) =>
      requested.includes(canonical) || aliases.some((alias) => requested.includes(alias)),
  );
  if (!group) return adFuel.includes(requested) || fullText.includes(requested);
  const [canonical, aliases] = group;
  return (
    adFuel.includes(canonical) ||
    aliases.some((alias) => adFuel.includes(alias) || fullText.includes(alias))
  );
}

function hardExclusionReasons(
  ad: LeboncoinAd,
  request: VehicleValuationRequest,
): string[] {
  const rawText = [ad.title, ad.description].filter(Boolean).join(" ");
  const normalizedText = textFor(ad);
  const reasons: string[] = [];

  if (!matchesToken(normalizedText, request.brand)) reasons.push("marque différente");
  if (!matchesToken(normalizedText, request.model)) reasons.push("modèle différent");
  if (explicitlyDifferentGeneration(ad, request)) reasons.push("génération différente");
  if (!Number.isFinite(ad.price) || ad.price < 500) reasons.push("prix invalide ou trop faible");
  if (DAMAGED_PATTERNS.some((pattern) => pattern.test(rawText))) {
    reasons.push(
      "véhicule accidenté, non roulant, vendu pour pièces ou nécessitant des réparations",
    );
  }
  if (FINANCING_PATTERNS.some((pattern) => pattern.test(rawText))) {
    reasons.push("prix présenté comme mensualité ou apport");
  }
  if (request.excludeCompanyVehicles) {
    const seats = String(ad.attributes?.seats ?? "").trim();
    const version = [
      ad.attributes?.u_car_version,
      ad.attributes?.u_car_finition,
      ad.attributes?.vehicle_type,
    ]
      .filter(Boolean)
      .join(" ");
    if (
      seats === "2" ||
      COMPANY_VEHICLE_PATTERNS.some(
        (pattern) => pattern.test(rawText) || pattern.test(version),
      )
    ) {
      reasons.push("véhicule de société, version Affaire/Entreprise ou 2 places");
    }
  }
  if (request.excludeProfessionalSellers) {
    const sellerType = normalize(
      ad.sellerType ?? String(ad.attributes?.owner_type ?? ""),
    );
    if (["pro", "professionnel", "professional"].includes(sellerType)) {
      reasons.push("annonce publiée par un vendeur professionnel");
    }
  }
  if (ad.year && Math.abs(ad.year - request.year) > 5) {
    reasons.push("année trop éloignée");
  }
  if (ad.mileage && Math.abs(ad.mileage - request.mileage) > 120_000) {
    reasons.push("kilométrage trop éloigné");
  }

  return reasons;
}

function scoreAd(ad: LeboncoinAd, request: VehicleValuationRequest): ComparableAd {
  const fullText = textFor(ad);
  const matchedCriteria = ["brand", "model"];
  const flags: string[] = [];
  let score = 0.35;

  const yearDifference = ad.year == null ? undefined : Math.abs(ad.year - request.year);
  if (yearDifference == null) {
    flags.push("année absente");
  } else {
    score += 0.2 * clamp(1 - yearDifference / 5);
    if (yearDifference <= 1) matchedCriteria.push("year");
  }

  const mileageDifference =
    ad.mileage == null ? undefined : Math.abs(ad.mileage - request.mileage);
  if (mileageDifference == null) {
    flags.push("kilométrage absent");
  } else {
    score += 0.2 * clamp(1 - mileageDifference / 120_000);
    if (mileageDifference <= 25_000) matchedCriteria.push("mileage");
  }

  const optionalCriteria: Array<{
    key: string;
    value?: string;
    weight: number;
    matches: () => boolean;
  }> = [
    {
      key: "fuel",
      value: request.fuel,
      weight: 0.1,
      matches: () => Boolean(request.fuel && fuelMatches(ad, request.fuel)),
    },
    {
      key: "generation",
      value: request.generation,
      weight: 0.04,
      matches: () => Boolean(request.generation && generationMatches(ad, request.generation)),
    },
    {
      key: "engine",
      value: request.engine,
      weight: 0.06,
      matches: () => matchesToken(fullText, request.engine),
    },
    {
      key: "gearbox",
      value: request.gearbox,
      weight: 0.03,
      matches: () => matchesToken(fullText, request.gearbox),
    },
    {
      key: "trim",
      value: request.trim,
      weight: 0.02,
      matches: () => matchesToken(fullText, request.trim),
    },
  ];

  for (const criterion of optionalCriteria) {
    if (!criterion.value) continue;
    if (criterion.matches()) {
      score += criterion.weight;
      matchedCriteria.push(criterion.key);
    } else {
      score -= criterion.weight * 0.65;
      flags.push(`${criterion.key} non confirmé`);
    }
  }

  const descriptionMaxChars = clamp(request.descriptionMaxChars ?? 1_200, 200, 5_000);
  const description =
    request.includeDescriptions === false
      ? undefined
      : ad.description?.slice(0, descriptionMaxChars);

  return {
    id: ad.id,
    title: ad.title,
    price: ad.price,
    url: ad.url,
    year: ad.year,
    mileage: ad.mileage,
    fuel: ad.fuel,
    location: ad.location,
    sellerType: ad.sellerType,
    description,
    characteristics: ad.attributes ?? {},
    images:
      request.includeImages === false
        ? undefined
        : ad.images?.length
          ? ad.images
          : ad.image
            ? [ad.image]
            : [],
    similarityScore: Math.round(clamp(score) * 100) / 100,
    matchedCriteria,
    flags,
    yearDifference,
    mileageDifference,
  };
}

function uniqueAds(ads: LeboncoinAd[]): LeboncoinAd[] {
  const seen = new Set<string>();
  return ads.filter((ad) => {
    const key = ad.id ? String(ad.id) : ad.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function calculateAdvancedValuation(
  request: VehicleValuationRequest,
  fetchedAds: LeboncoinAd[],
): AdvancedVehicleValuation {
  const excludedAds: ExcludedAd[] = [];
  const candidates: LeboncoinAd[] = [];
  const ads = uniqueAds(fetchedAds);

  for (const ad of ads) {
    const reasons = hardExclusionReasons(ad, request);
    if (reasons.length > 0) {
      excludedAds.push({
        id: ad.id,
        title: ad.title,
        price: ad.price,
        url: ad.url,
        reasons,
      });
    } else {
      candidates.push(ad);
    }
  }

  let scored = candidates.map((ad) => scoreAd(ad, request));
  const prices = scored.map((ad) => ad.price);
  if (prices.length >= 4) {
    const q1 = percentile(prices, 0.25);
    const q3 = percentile(prices, 0.75);
    const iqr = q3 - q1;
    const lowerFence = Math.max(500, q1 - 1.5 * iqr);
    const upperFence = q3 + 1.5 * iqr;
    scored = scored.filter((ad) => {
      if (ad.price >= lowerFence && ad.price <= upperFence) return true;
      excludedAds.push({
        id: ad.id,
        title: ad.title,
        price: ad.price,
        url: ad.url,
        reasons: ["prix statistiquement atypique"],
      });
      return false;
    });
  }

  scored.sort(
    (a, b) =>
      b.similarityScore - a.similarityScore ||
      (a.yearDifference ?? Number.MAX_SAFE_INTEGER) -
        (b.yearDifference ?? Number.MAX_SAFE_INTEGER) ||
      (a.mileageDifference ?? Number.MAX_SAFE_INTEGER) -
        (b.mileageDifference ?? Number.MAX_SAFE_INTEGER),
  );

  const maxComparables = Math.round(clamp(request.maxComparables ?? 20, 5, 35));
  const comparables = scored.slice(0, maxComparables);
  const weightedPrices = comparables.map((ad) => ({
    price: ad.price,
    weight: Math.max(0.2, ad.similarityScore ** 2),
  }));
  const estimatedPrice = roundTo(weightedPercentile(weightedPrices, 0.5), 50);
  const lowPrice = roundTo(weightedPercentile(weightedPrices, 0.25), 50);
  const highPrice = roundTo(weightedPercentile(weightedPrices, 0.75), 50);
  const quickSalePrice = roundTo(Math.min(lowPrice, estimatedPrice * 0.92), 50);
  const medianSimilarity = percentile(
    comparables.map((ad) => ad.similarityScore),
    0.5,
  );
  const priceSpread =
    estimatedPrice > 0 ? Math.max(0, (highPrice - lowPrice) / estimatedPrice) : 1;
  const volumeScore = clamp(comparables.length / 12);
  const spreadScore = clamp(1 - priceSpread / 0.55);
  const confidenceScore = Math.round(
    clamp(volumeScore * 0.45 + medianSimilarity * 0.4 + spreadScore * 0.15) * 100,
  );
  const confidence =
    confidenceScore >= 75 ? "high" : confidenceScore >= 50 ? "medium" : "low";
  const warnings: string[] = [];

  if (comparables.length < 5) {
    warnings.push("Moins de 5 annonces comparables : la cote est peu fiable.");
  }
  if (medianSimilarity < 0.65 && comparables.length > 0) {
    warnings.push("Les annonces retenues correspondent imparfaitement au véhicule demandé.");
  }
  if (request.engine && !comparables.some((ad) => ad.matchedCriteria.includes("engine"))) {
    warnings.push("La motorisation exacte n'a été confirmée dans aucune annonce.");
  }
  if (comparables.length === 0) {
    warnings.push("Aucune annonce suffisamment comparable n'a été trouvée.");
  }

  return {
    request,
    valuation: {
      estimatedPrice,
      lowPrice,
      highPrice,
      quickSalePrice,
      currency: "EUR",
      confidence,
      confidenceScore,
      method:
        "médiane pondérée par similarité, bornes interquartiles et exclusion des anomalies",
    },
    market: {
      adsFetched: ads.length,
      adsAnalyzed: scored.length + excludedAds.length,
      comparablesUsed: comparables.length,
      excludedCount: excludedAds.length,
      medianSimilarity: Math.round(medianSimilarity * 100) / 100,
      priceSpread: Math.round(priceSpread * 100) / 100,
      fetchedAt: new Date().toISOString(),
    },
    comparables,
    excludedAds,
    warnings,
  };
}

export async function estimateUsedVehicle(
  request: VehicleValuationRequest,
): Promise<AdvancedVehicleValuation> {
  const cacheKey = JSON.stringify(request);
  const cached = valuationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  if (cached) valuationCache.delete(cacheKey);

  const resolution = await resolveLeboncoinVehicleWithDiscovery({
    brand: request.brand,
    model: request.model,
    generation: request.generation,
    fuel: request.fuel,
    engine: request.engine,
    trim: request.trim,
    discoverFromLeboncoin: true,
  });
  const useResolvedIdentifiers = resolution.confidenceScore >= 90;
  const effectiveRequest: VehicleValuationRequest = {
    ...request,
    brand: resolution.brand ?? request.brand,
    model: resolution.model || request.model,
    generation: resolution.generation ?? request.generation,
    fuel: resolution.fuel ?? request.fuel,
    trim: resolution.trim ?? request.trim,
    leboncoinBrand:
      request.leboncoinBrand ??
      (useResolvedIdentifiers ? resolution.leboncoinBrand : undefined),
    leboncoinModel:
      request.leboncoinModel ??
      (useResolvedIdentifiers ? resolution.leboncoinModel : undefined),
  };

  const mileageMargin = Math.max(
    35_000,
    Math.round(effectiveRequest.mileage * 0.35),
  );
  const searchParams = {
    brand: effectiveRequest.brand,
    model: effectiveRequest.model,
    lbcBrand: effectiveRequest.leboncoinBrand,
    lbcModel: effectiveRequest.leboncoinModel,
    yearMin: effectiveRequest.year - 2,
    yearMax: effectiveRequest.year + 2,
    mileageMin: Math.max(0, effectiveRequest.mileage - mileageMargin),
    mileageMax: effectiveRequest.mileage + mileageMargin,
    fuel: effectiveRequest.fuel ? fuelToLbcCode(effectiveRequest.fuel) : undefined,
    gearbox: effectiveRequest.gearbox
      ? gearboxToLbcCode(effectiveRequest.gearbox)
      : undefined,
    ownerType: effectiveRequest.excludeProfessionalSellers
      ? ("private" as const)
      : ("all" as const),
    location: effectiveRequest.location,
  };

  let ads: LeboncoinAd[];
  try {
    ads = uniqueAds(await searchLeboncoinViaPython(searchParams));
  } catch (error) {
    console.error("[MCP valuation] Python Leboncoin search failed:", error);
    throw new Error(
      "Leboncoin bloque temporairement la recherche. Réessaie dans quelques minutes.",
    );
  }

  const result = calculateAdvancedValuation(effectiveRequest, ads);
  result.warnings = [
    ...new Set([...resolution.warnings, ...result.warnings]),
  ];
  const cacheTtlMs = Math.max(
    60_000,
    Number(process.env.VALUATION_CACHE_TTL_MS ?? 15 * 60_000),
  );
  valuationCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, result });
  if (valuationCache.size > 100) {
    const oldestKey = valuationCache.keys().next().value;
    if (oldestKey) valuationCache.delete(oldestKey);
  }
  return result;
}
