import assert from "node:assert/strict";
import test from "node:test";
import { calculateAdvancedValuation } from "./advanced-valuation";
import type { LeboncoinAd } from "./types";

function ad(
  id: number,
  price: number,
  overrides: Partial<LeboncoinAd> = {},
): LeboncoinAd {
  return {
    id,
    title: "Renault Clio 3 1.5 dCi diesel",
    price,
    url: `https://example.test/${id}`,
    year: 2010,
    mileage: 100_000,
    fuel: "Diesel",
    description: "Clio III entretenue, contrôle technique valide.",
    attributes: {
      brand: "Renault",
      model: "Clio",
      regdate: "2010",
      mileage: "100000",
      fuel: "Diesel",
    },
    ...overrides,
  };
}

test("calcule une cote avec les annonces comparables et explique les exclusions", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Renault",
      model: "Clio",
      generation: "3",
      engine: "1.5 dCi",
      fuel: "diesel",
      year: 2010,
      yearMin: 2009,
      yearMax: 2011,
      mileage: 100_000,
      maxComparables: 10,
    },
    [
      ad(1, 4_800),
      ad(2, 5_000, { year: 2011, mileage: 110_000 }),
      ad(3, 5_200, { year: 2009, mileage: 92_000 }),
      ad(4, 5_400, { mileage: 85_000 }),
      ad(5, 1_200, {
        title: "Renault Clio 3 accidentée pour pièces",
        description: "Moteur HS, non roulant.",
      }),
      ad(6, 5_100, {
        title: "Peugeot 207 HDI diesel",
        description: "Peugeot 207 entretenue.",
        attributes: { brand: "Peugeot", model: "207", fuel: "Diesel" },
      }),
      ad(7, 199, {
        title: "Renault Clio 3 dès 199 € / mois",
        description: "Financement avec apport.",
      }),
      ad(8, 4_200, {
        title: "Renault Clio 2 Campus dCi",
        description: "Clio 2 diesel entretenue.",
        attributes: { brand: "Renault", model: "Clio 2", fuel: "Diesel" },
      }),
      ad(9, 1_500, {
        description: "Problème d'injection et perte de puissance.",
      }),
    ],
  );

  assert.equal(result.market.comparablesUsed, 4);
  assert.equal(result.valuation.estimatedPrice, 5_000);
  assert.ok(result.valuation.lowPrice <= result.valuation.estimatedPrice);
  assert.ok(result.valuation.highPrice >= result.valuation.estimatedPrice);
  assert.ok(result.comparables.every((item) => item.description));
  assert.ok(result.comparables.every((item) => item.characteristics.brand === "Renault"));
  assert.ok(
    result.excludedAds.some((item) =>
      item.reasons.some((reason) => reason.includes("accidenté")),
    ),
  );
  assert.ok(
    result.excludedAds.some((item) =>
      item.reasons.some((reason) => reason.includes("modèle différent")),
    ),
  );
  assert.ok(
    result.excludedAds.some((item) =>
      item.reasons.some((reason) => reason.includes("prix invalide")),
    ),
  );
  assert.ok(
    result.excludedAds.some((item) =>
      item.reasons.some((reason) => reason.includes("génération différente")),
    ),
  );
  assert.ok(
    result.excludedAds.some((item) =>
      item.reasons.some((reason) => reason.includes("réparations")),
    ),
  );
});

test("filtre sur l'année exacte par défaut", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Peugeot",
      model: "208",
      year: 2021,
      mileage: 100_000,
    },
    [
      ad(40, 11_500, {
        title: "Peugeot 208",
        year: 2021,
        attributes: { brand: "Peugeot", model: "208", regdate: "2021" },
      }),
      ad(41, 10_500, {
        title: "Peugeot 208",
        year: 2020,
        attributes: { brand: "Peugeot", model: "208", regdate: "2020" },
      }),
      ad(42, 12_500, {
        title: "Peugeot 208",
        year: 2022,
        attributes: { brand: "Peugeot", model: "208", regdate: "2022" },
      }),
      ad(43, 11_000, {
        title: "Peugeot 208",
        year: undefined,
        attributes: { brand: "Peugeot", model: "208" },
      }),
    ],
  );

  assert.deepEqual(result.comparables.map((item) => item.id), [40]);
  assert.ok(
    result.excludedAds.some(
      (item) => item.id === 41 && item.reasons.includes("année différente de 2021"),
    ),
  );
  assert.ok(
    result.excludedAds.some(
      (item) => item.id === 43 && item.reasons.includes("année absente"),
    ),
  );
});

test("accepte un intervalle d'années explicite", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Peugeot",
      model: "208",
      year: 2021,
      yearMin: 2020,
      yearMax: 2022,
      mileage: 100_000,
    },
    [
      ad(50, 10_500, {
        title: "Peugeot 208",
        year: 2020,
        attributes: { brand: "Peugeot", model: "208", regdate: "2020" },
      }),
      ad(51, 11_500, {
        title: "Peugeot 208",
        year: 2021,
        attributes: { brand: "Peugeot", model: "208", regdate: "2021" },
      }),
      ad(52, 12_500, {
        title: "Peugeot 208",
        year: 2022,
        attributes: { brand: "Peugeot", model: "208", regdate: "2022" },
      }),
      ad(53, 9_500, {
        title: "Peugeot 208",
        year: 2019,
        attributes: { brand: "Peugeot", model: "208", regdate: "2019" },
      }),
    ],
  );

  assert.deepEqual(
    result.comparables.map((item) => item.year).sort(),
    [2020, 2021, 2022],
  );
  assert.ok(
    result.excludedAds.some(
      (item) =>
        item.id === 53 && item.reasons.includes("année hors intervalle 2020–2022"),
    ),
  );
});

test("refuse un intervalle d'années incohérent", () => {
  assert.throws(
    () =>
      calculateAdvancedValuation(
        {
          brand: "Peugeot",
          model: "208",
          year: 2021,
          yearMin: 2022,
          yearMax: 2020,
          mileage: 100_000,
        },
        [],
      ),
    /yearMin doit être inférieur ou égal à yearMax/,
  );
});

test("refuse une seule borne d'année", () => {
  assert.throws(
    () =>
      calculateAdvancedValuation(
        {
          brand: "Peugeot",
          model: "208",
          year: 2021,
          yearMin: 2020,
          mileage: 100_000,
        },
        [],
      ),
    /yearMin et yearMax doivent être fournis ensemble/,
  );
});

test("exclut les véhicules de société lorsque demandé", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Peugeot",
      model: "208",
      year: 2021,
      mileage: 115_000,
      fuel: "diesel",
      excludeCompanyVehicles: true,
    },
    [
      ad(10, 7_490, {
        title: "Peugeot 208 Affaire BlueHDi Premium Pack 2 places",
        year: 2021,
        mileage: 114_000,
        attributes: {
          brand: "Peugeot",
          model: "208",
          seats: "2",
          u_car_version: "208 Affaire 1.5 BlueHDi 100 Premium Pack",
        },
      }),
      ad(11, 11_900, {
        title: "Peugeot 208 BlueHDi 100 Allure 5 places",
        year: 2021,
        mileage: 116_000,
        attributes: {
          brand: "Peugeot",
          model: "208",
          seats: "5",
          u_car_version: "208 1.5 BlueHDi 100 Allure",
        },
      }),
    ],
  );

  assert.equal(result.market.comparablesUsed, 1);
  assert.equal(result.comparables[0]?.id, 11);
  assert.ok(
    result.excludedAds.some(
      (item) =>
        item.id === 10 && item.reasons.some((reason) => reason.includes("société")),
    ),
  );
});

test("ne confond pas une cylindrée avec la génération", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Peugeot",
      model: "208",
      generation: "2",
      year: 2021,
      mileage: 115_000,
      fuel: "diesel",
    },
    [
      ad(20, 11_900, {
        title: "Peugeot 208 1.5 BlueHDi 100 Allure",
        year: 2021,
        mileage: 115_000,
        attributes: { brand: "Peugeot", model: "208", fuel: "Diesel" },
      }),
      ad(21, 8_000, {
        title: "Peugeot 208 I 1.6 BlueHDi 100",
        year: 2018,
        mileage: 120_000,
        attributes: { brand: "Peugeot", model: "208", fuel: "Diesel" },
      }),
    ],
  );

  assert.equal(result.comparables[0]?.id, 20);
  assert.ok(
    result.excludedAds.some(
      (item) =>
        item.id === 21 && item.reasons.some((reason) => reason.includes("génération")),
    ),
  );
});

test("exclut les annonces de vendeurs professionnels lorsque demandé", () => {
  const result = calculateAdvancedValuation(
    {
      brand: "Renault",
      model: "Clio",
      year: 2010,
      mileage: 100_000,
      excludeProfessionalSellers: true,
    },
    [
      ad(30, 5_200, { sellerType: "pro" }),
      ad(31, 4_900, { sellerType: "private" }),
    ],
  );

  assert.equal(result.market.comparablesUsed, 1);
  assert.equal(result.comparables[0]?.id, 31);
  assert.ok(
    result.excludedAds.some(
      (item) =>
        item.id === 30 &&
        item.reasons.some((reason) => reason.includes("vendeur professionnel")),
    ),
  );
});
