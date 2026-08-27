import assert from "node:assert/strict";
import test from "node:test";
import { resolveLeboncoinVehicle } from "./resolver";
import type { LeboncoinAd } from "./types";

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
