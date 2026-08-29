import {
  getLeboncoinVehicleCatalogViaPython,
  getLeboncoinVehicleTrimsViaPython,
  searchLeboncoinViaPython,
} from "./client";
import type {
  LeboncoinAd,
  LeboncoinCatalogOption,
  LeboncoinVehicleCatalog,
  LeboncoinVehicleCatalogBrand,
  LeboncoinVehicleTrims,
} from "./types";

export type VehicleResolutionInput = {
  brand?: string;
  model: string;
  generation?: string;
  fuel?: string;
  engine?: string;
  trim?: string;
  discoverFromLeboncoin?: boolean;
};

export type VehicleResolution = {
  resolved: boolean;
  brand?: string;
  model: string;
  leboncoinBrand?: string;
  leboncoinModel?: string;
  generation?: string;
  fuel?: string;
  leboncoinFuel?: string;
  engine?: string;
  trim?: string;
  leboncoinTrim?: string;
  confidenceScore: number;
  source:
    | "catalog"
    | "leboncoin-catalog"
    | "leboncoin-observed"
    | "heuristic"
    | "ambiguous";
  warnings: string[];
  alternatives: Array<{
    leboncoinBrand: string;
    leboncoinModel: string;
    score: number;
  }>;
};

type BrandEntry = {
  id: string;
  display: string;
  aliases: string[];
};

type ModelEntry = {
  brand: string;
  value: string;
  aliases: string[];
};

const BRANDS: BrandEntry[] = [
  { id: "RENAULT", display: "Renault", aliases: ["renault"] },
  { id: "PEUGEOT", display: "Peugeot", aliases: ["peugeot"] },
  { id: "CITROEN", display: "Citroën", aliases: ["citroen", "citroën"] },
  { id: "DACIA", display: "Dacia", aliases: ["dacia"] },
  { id: "VOLKSWAGEN", display: "Volkswagen", aliases: ["volkswagen", "vw"] },
  { id: "BMW", display: "BMW", aliases: ["bmw"] },
  {
    id: "MERCEDES-BENZ",
    display: "Mercedes-Benz",
    aliases: ["mercedes", "mercedes benz", "mercedes-benz"],
  },
  { id: "AUDI", display: "Audi", aliases: ["audi"] },
  { id: "TOYOTA", display: "Toyota", aliases: ["toyota"] },
  { id: "FORD", display: "Ford", aliases: ["ford"] },
  { id: "OPEL", display: "Opel", aliases: ["opel"] },
  { id: "FIAT", display: "Fiat", aliases: ["fiat"] },
  { id: "KIA", display: "Kia", aliases: ["kia"] },
  { id: "HYUNDAI", display: "Hyundai", aliases: ["hyundai"] },
  { id: "NISSAN", display: "Nissan", aliases: ["nissan"] },
  { id: "HONDA", display: "Honda", aliases: ["honda"] },
  { id: "TESLA", display: "Tesla", aliases: ["tesla"] },
  { id: "VOLVO", display: "Volvo", aliases: ["volvo"] },
  { id: "SKODA", display: "Škoda", aliases: ["skoda", "škoda"] },
  { id: "SEAT", display: "Seat", aliases: ["seat"] },
];

// Valeurs dont la casse/ponctuation a été observée dans les filtres Leboncoin.
// Le reste est découvert à la demande depuis les attributs des annonces.
const MODELS: ModelEntry[] = [
  { brand: "RENAULT", value: "Clio", aliases: ["clio"] },
  { brand: "PEUGEOT", value: "208", aliases: ["208"] },
  { brand: "VOLKSWAGEN", value: "Golf", aliases: ["golf"] },
  { brand: "TESLA", value: "Model 3", aliases: ["model 3", "model trois"] },
  { brand: "KIA", value: "Niro", aliases: ["niro"] },
  { brand: "HONDA", value: "Jazz", aliases: ["jazz"] },
  { brand: "AUDI", value: "Q3", aliases: ["q3"] },
  { brand: "FIAT", value: "500", aliases: ["500"] },
];

const FUEL_CODES: Array<{ value: string; code: string; aliases: string[] }> = [
  {
    value: "hybride rechargeable",
    code: "8",
    aliases: ["hybride rechargeable", "plug in hybrid", "phev"],
  },
  { value: "électrique", code: "4", aliases: ["electrique", "électrique", "ev"] },
  { value: "hybride", code: "6", aliases: ["hybride", "hybrid", "hev"] },
  { value: "diesel", code: "2", aliases: ["diesel", "gasoil"] },
  { value: "essence", code: "1", aliases: ["essence", "petrol"] },
  { value: "GPL", code: "3", aliases: ["gpl", "lpg"] },
];

const ROMAN_TO_NUMBER: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
};

function normalize(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findBrand(value: string | undefined): BrandEntry | undefined {
  const normalized = normalize(value);
  return BRANDS.find((brand) =>
    [brand.id, brand.display, ...brand.aliases].some(
      (alias) => normalize(alias) === normalized,
    ),
  );
}

function normalizeGeneration(value: string | undefined): string | undefined {
  const normalized = normalize(value)
    .replace(/^(?:generation|gen)\s+/, "")
    .trim();
  if (!normalized) return undefined;
  return ROMAN_TO_NUMBER[normalized] ?? normalized;
}

function findKnownModel(
  model: string,
  brandId?: string,
): ModelEntry | undefined {
  const normalized = normalize(model);
  return MODELS.find(
    (entry) =>
      (!brandId || entry.brand === brandId) &&
      entry.aliases.some((alias) => normalize(alias) === normalized),
  );
}

function splitGeneration(
  rawModel: string,
  brandId?: string,
): { model: string; generation?: string } {
  const exactKnown = findKnownModel(rawModel, brandId);
  if (exactKnown) return { model: exactKnown.value };

  const normalized = normalize(rawModel);
  for (const entry of MODELS.filter((model) => !brandId || model.brand === brandId)) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (!normalized.startsWith(`${normalizedAlias} `)) continue;
      const suffix = normalized.slice(normalizedAlias.length).trim();
      const match = suffix.match(/^(?:(?:generation|gen|phase|ph)\s*)?([1-8]|i{1,3}|iv|v(?:i{0,3})?)$/);
      if (match) {
        return {
          model: entry.value,
          generation: normalizeGeneration(match[1]),
        };
      }
    }
  }

  return { model: rawModel.trim() };
}

function titleCaseModel(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (/^[a-z]\d+$/i.test(part)) return part.toUpperCase();
      if (/^\d+$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length]!;
}

function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  return Math.max(0, 1 - editDistance(left, right) / Math.max(left.length, right.length));
}

function generationSuffix(value: string): string | undefined {
  const match = normalize(value).match(
    /^(?:(?:generation|gen|phase|ph)\s*)?([1-8]|i{1,3}|iv|v(?:i{0,3})?)$/,
  );
  return match ? normalizeGeneration(match[1]) : undefined;
}

function catalogBrandFor(
  catalog: LeboncoinVehicleCatalog,
  requestedBrand: string | undefined,
): LeboncoinVehicleCatalogBrand | undefined {
  const normalized = normalize(requestedBrand);
  const localBrand = findBrand(requestedBrand);
  return catalog.brands.find(
    (brand) =>
      normalize(brand.value) === normalized ||
      normalize(brand.label) === normalized ||
      brand.value === localBrand?.id,
  );
}

function catalogModelCandidates(
  requestedModel: string,
  brand: LeboncoinVehicleCatalogBrand,
): Array<{ option: LeboncoinCatalogOption; score: number; generation?: string }> {
  const requested = normalize(requestedModel);
  return brand.models
    .map((option) => {
      const label = normalize(option.label);
      const identifier = normalize(option.value);
      if (requested === label || requested === identifier) {
        return { option, score: 1 };
      }
      if (requested.startsWith(`${label} `)) {
        const generation = generationSuffix(requested.slice(label.length).trim());
        if (generation) return { option, score: 0.99, generation };
      }
      return { option, score: similarity(requestedModel, option.label) };
    })
    .sort((left, right) => right.score - left.score);
}

export function resolveLeboncoinVehicleFromCatalog(
  input: VehicleResolutionInput,
  catalog: LeboncoinVehicleCatalog,
): VehicleResolution | undefined {
  let brand = catalogBrandFor(catalog, input.brand);
  if (!brand && !input.brand) {
    const matches = catalog.brands.flatMap((candidateBrand) =>
      catalogModelCandidates(input.model, candidateBrand)
        .filter((candidate) => candidate.score === 1)
        .map((candidate) => ({ brand: candidateBrand, candidate })),
    );
    if (matches.length === 1) brand = matches[0]?.brand;
  }
  if (!brand) return undefined;

  const candidates = catalogModelCandidates(input.model, brand);
  const best = candidates[0];
  if (!best || best.score < 0.8) return undefined;
  const fuel = resolveFuel(input.fuel);
  const localBrand = findBrand(brand.value);
  const warnings =
    catalog.cacheStatus === "stale"
      ? ["Le catalogue Leboncoin en cache est périmé mais reste exploitable."]
      : [];

  return {
    resolved: true,
    brand: localBrand?.display ?? brand.label,
    model: best.option.label,
    leboncoinBrand: brand.value,
    leboncoinModel: best.option.value,
    generation:
      normalizeGeneration(input.generation) ?? best.generation,
    fuel: fuel?.value ?? input.fuel,
    leboncoinFuel: fuel?.code,
    engine: input.engine,
    trim: input.trim,
    confidenceScore: Math.round(best.score * 100),
    source: "leboncoin-catalog",
    warnings,
    alternatives: candidates.slice(0, 5).map((candidate) => ({
      leboncoinBrand: brand.value,
      leboncoinModel: candidate.option.value,
      score: Math.round(candidate.score * 100) / 100,
    })),
  };
}

export function resolveLeboncoinTrimFromCatalog(
  requestedTrim: string | undefined,
  trims: LeboncoinVehicleTrims,
): LeboncoinCatalogOption | undefined {
  if (!requestedTrim) return undefined;
  const requested = normalize(requestedTrim);
  const ranked = trims.values
    .map((option) => {
      const label = normalize(option.label);
      const score =
        requested === label
          ? 1
          : requested.startsWith(`${label} `)
            ? 0.9
            : similarity(requestedTrim, option.label);
      return { option, score };
    })
    .sort((left, right) => right.score - left.score);
  return ranked[0] && ranked[0].score >= 0.75
    ? ranked[0].option
    : undefined;
}

function resolveFuel(value: string | undefined) {
  const normalized = normalize(value);
  if (!normalized) return undefined;
  return FUEL_CODES.find((fuel) =>
    fuel.aliases.some((alias) => normalized.includes(normalize(alias))),
  );
}

function candidatesFromAds(
  ads: LeboncoinAd[],
  requestedModel: string,
  requestedBrand?: string,
): VehicleResolution["alternatives"] {
  const counts = new Map<string, { brand: string; model: string; count: number }>();
  for (const ad of ads) {
    const brand = ad.attributes?.u_car_brand;
    const model = ad.attributes?.u_car_model;
    if (typeof brand !== "string" || typeof model !== "string") continue;
    const key = `${brand}\u0000${model}`;
    const current = counts.get(key);
    counts.set(key, { brand, model, count: (current?.count ?? 0) + 1 });
  }

  return [...counts.values()]
    .map((candidate) => {
      const modelLabel = candidate.model.split("_").slice(1).join("_");
      const modelScore = similarity(modelLabel, requestedModel);
      const brandScore = requestedBrand
        ? similarity(candidate.brand, requestedBrand)
        : 0.8;
      return {
        leboncoinBrand: candidate.brand,
        leboncoinModel: candidate.model,
        score:
          Math.round(
            (modelScore * 0.75 + brandScore * 0.2 + Math.min(candidate.count / 20, 1) * 0.05) *
              100,
          ) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export function resolveLeboncoinVehicle(
  input: VehicleResolutionInput,
  observedAds: LeboncoinAd[] = [],
): VehicleResolution {
  let brand = findBrand(input.brand);
  const split = splitGeneration(input.model, brand?.id);
  const generation = normalizeGeneration(input.generation) ?? split.generation;
  let knownModel = findKnownModel(split.model, brand?.id);

  if (!brand && knownModel) {
    brand = BRANDS.find((entry) => entry.id === knownModel!.brand);
  }
  if (!knownModel && brand) {
    knownModel = findKnownModel(input.model, brand.id);
  }

  const alternatives = candidatesFromAds(
    observedAds,
    split.model,
    brand?.id ?? input.brand,
  );
  const observed = alternatives[0];
  const fuel = resolveFuel(input.fuel);
  const warnings: string[] = [];

  if (observed && observed.score >= 0.72) {
    const observedBrand =
      BRANDS.find((entry) => entry.id === observed.leboncoinBrand) ?? brand;
    const observedModel = observed.leboncoinModel.split("_").slice(1).join("_");
    return {
      resolved: true,
      brand: observedBrand?.display ?? input.brand,
      model: observedModel,
      leboncoinBrand: observed.leboncoinBrand,
      leboncoinModel: observed.leboncoinModel,
      generation,
      fuel: fuel?.value ?? input.fuel,
      leboncoinFuel: fuel?.code,
      engine: input.engine,
      trim: input.trim,
      confidenceScore: Math.round(observed.score * 100),
      source: "leboncoin-observed",
      warnings,
      alternatives,
    };
  }

  if (brand && knownModel) {
    return {
      resolved: true,
      brand: brand.display,
      model: knownModel.value,
      leboncoinBrand: brand.id,
      leboncoinModel: `${brand.id}_${knownModel.value}`,
      generation,
      fuel: fuel?.value ?? input.fuel,
      leboncoinFuel: fuel?.code,
      engine: input.engine,
      trim: input.trim,
      confidenceScore: 98,
      source: "catalog",
      warnings,
      alternatives,
    };
  }

  const heuristicModel = titleCaseModel(split.model);
  if (!brand) warnings.push("Marque inconnue ou absente : identifiant Leboncoin non confirmé.");
  if (!knownModel) warnings.push("Modèle absent du catalogue local : validation Leboncoin conseillée.");

  return {
    resolved: Boolean(brand),
    brand: brand?.display ?? input.brand,
    model: heuristicModel,
    leboncoinBrand: brand?.id,
    leboncoinModel: brand ? `${brand.id}_${heuristicModel}` : undefined,
    generation,
    fuel: fuel?.value ?? input.fuel,
    leboncoinFuel: fuel?.code,
    engine: input.engine,
    trim: input.trim,
    confidenceScore: brand ? 65 : 30,
    source: brand ? "heuristic" : "ambiguous",
    warnings,
    alternatives,
  };
}

export async function resolveLeboncoinVehicleWithDiscovery(
  input: VehicleResolutionInput,
): Promise<VehicleResolution> {
  const local = resolveLeboncoinVehicle(input);
  if (input.discoverFromLeboncoin === false) return local;

  let catalogWarning: string | undefined;
  try {
    const catalog = await getLeboncoinVehicleCatalogViaPython();
    const catalogResolution = resolveLeboncoinVehicleFromCatalog(input, catalog);
    if (catalogResolution) {
      if (input.trim && catalogResolution.leboncoinModel) {
        try {
          const trims = await getLeboncoinVehicleTrimsViaPython(
            catalogResolution.leboncoinModel,
          );
          const trim = resolveLeboncoinTrimFromCatalog(input.trim, trims);
          if (trim) {
            catalogResolution.trim = trim.label;
            catalogResolution.leboncoinTrim = trim.value;
            if (normalize(input.trim) !== normalize(trim.label)) {
              catalogResolution.warnings.push(
                `La finition « ${input.trim} » a été rapprochée de « ${trim.label} » dans le catalogue Leboncoin.`,
              );
            }
          } else {
            catalogResolution.warnings.push(
              "La finition exacte n'a pas été trouvée dans le catalogue Leboncoin.",
            );
          }
          if (trims.cacheStatus === "stale") {
            catalogResolution.warnings.push(
              "Les finitions proviennent d'un cache Leboncoin périmé.",
            );
          }
        } catch (trimError) {
          console.error("[LBC resolver] Trim discovery failed:", trimError);
          catalogResolution.warnings.push(
            "Leboncoin n'a pas pu confirmer la finition pour le moment.",
          );
        }
      }
      return catalogResolution;
    }
  } catch (catalogError) {
    console.error("[LBC resolver] Catalog discovery failed:", catalogError);
    catalogWarning =
      "Le catalogue Leboncoin est indisponible ; résolution de secours utilisée.";
  }

  if (local.source === "catalog") {
    return catalogWarning
      ? { ...local, warnings: [...local.warnings, catalogWarning] }
      : local;
  }

  let ads: LeboncoinAd[] = [];
  const searchParams = {
    brand: local.brand ?? input.brand ?? "",
    model: local.model,
    maxPages: 1,
  };

  try {
    ads = await searchLeboncoinViaPython(searchParams);
  } catch (pythonError) {
    console.error("[LBC resolver] Python discovery failed:", pythonError);
    return {
      ...local,
      warnings: [
        ...local.warnings,
        ...(catalogWarning ? [catalogWarning] : []),
        "Leboncoin n'a pas pu confirmer l'identifiant pour le moment.",
      ],
    };
  }

  const observed = resolveLeboncoinVehicle(input, ads);
  return catalogWarning
    ? { ...observed, warnings: [...observed.warnings, catalogWarning] }
    : observed;
}
