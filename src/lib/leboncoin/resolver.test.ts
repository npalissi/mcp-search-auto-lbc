import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLeboncoinTrimFromCatalog,
  resolveLeboncoinVehicle,
  resolveLeboncoinVehicleFromCatalog,
} from "./resolver";
import type {
  LeboncoinAd,
  LeboncoinVehicleCatalog,
  LeboncoinVehicleTrims,
} from "./types";

const dynamicCatalog: LeboncoinVehicleCatalog = {
  version: 1,
  sourceVersion: "test",
  fetchedAt: "2026-08-29T08:00:00.000Z",
  cacheStatus: "fresh",
  brands: [
    {
      value: "CITROEN",
      label: "CITROEN",
      models: [
        { value: "CITROEN_C3", label: "C3" },
        { value: "CITROEN_C3 Aircross", label: "C3 Aircross" },
      ],
    },
  ],
};

test("résout une Clio III avec les identifiants exacts Leboncoin", () => {
  const result = resolveLeboncoinVehicle({
    brand: "renault",
    model: "clio III",
    fuel: "gasoil",
    engine: "1.5 dCi 90",
  });

  assert.equal(result.leboncoinBrand, "RENAULT");
  assert.equal(result.leboncoinModel, "RENAULT_Clio");
  assert.equal(result.generation, "3");
  assert.equal(result.leboncoinFuel, "2");
  assert.equal(result.source, "catalog");
});

test("ne confond pas Tesla Model 3 avec une génération", () => {
  const result = resolveLeboncoinVehicle({
    brand: "tesla",
    model: "model trois",
    fuel: "électrique",
  });

  assert.equal(result.leboncoinModel, "TESLA_Model 3");
  assert.equal(result.generation, undefined);
  assert.equal(result.leboncoinFuel, "4");
});

test("préfère les valeurs réellement observées dans les annonces", () => {
  const ads: LeboncoinAd[] = [
    {
      id: 1,
      title: "Skoda Octavia",
      price: 10_000,
      url: "https://example.test/1",
      attributes: {
        u_car_brand: "SKODA",
        u_car_model: "SKODA_Octavia",
      },
    },
  ];
  const result = resolveLeboncoinVehicle(
    { brand: "Skoda", model: "Octavia" },
    ads,
  );

  assert.equal(result.leboncoinBrand, "SKODA");
  assert.equal(result.leboncoinModel, "SKODA_Octavia");
  assert.equal(result.source, "leboncoin-observed");
});

test("résout un modèle absent du catalogue manuel depuis le catalogue Leboncoin", () => {
  const result = resolveLeboncoinVehicleFromCatalog(
    { brand: "Citroën", model: "C3 III", fuel: "diesel" },
    dynamicCatalog,
  );

  assert.equal(result?.leboncoinBrand, "CITROEN");
  assert.equal(result?.leboncoinModel, "CITROEN_C3");
  assert.equal(result?.generation, "3");
  assert.equal(result?.source, "leboncoin-catalog");
  assert.equal(result?.confidenceScore, 99);
});

test("ne confond pas C3 et C3 Aircross dans le catalogue dynamique", () => {
  const result = resolveLeboncoinVehicleFromCatalog(
    { brand: "CITROEN", model: "C3 Aircross" },
    dynamicCatalog,
  );

  assert.equal(result?.leboncoinModel, "CITROEN_C3 Aircross");
  assert.equal(result?.confidenceScore, 100);
});

test("résout une finition Leboncoin exacte ou préfixée", () => {
  const trims: LeboncoinVehicleTrims = {
    model: "CITROEN_C3",
    fetchedAt: "2026-08-29T08:00:00.000Z",
    cacheStatus: "fresh",
    values: [
      { value: "CITROEN_C3_Feel", label: "Feel" },
      { value: "CITROEN_C3_Feel Business", label: "Feel Business" },
    ],
  };

  assert.equal(
    resolveLeboncoinTrimFromCatalog("Feel Nav", trims)?.value,
    "CITROEN_C3_Feel",
  );
  assert.equal(
    resolveLeboncoinTrimFromCatalog("Feel Business", trims)?.value,
    "CITROEN_C3_Feel Business",
  );
});
