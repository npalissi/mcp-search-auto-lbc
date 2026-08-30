import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdvancedVehicleValuation } from "../src/lib/leboncoin/advanced-valuation";
import { createMcpHttpApp } from "./server";

const fixture: AdvancedVehicleValuation = {
  request: {
    brand: "Renault",
    model: "Clio",
    generation: "3",
    year: 2010,
    mileage: 100_000,
    fuel: "diesel",
  },
  valuation: {
    estimatedPrice: 5_000,
    lowPrice: 4_600,
    highPrice: 5_400,
    quickSalePrice: 4_500,
    currency: "EUR",
    confidence: "high",
    confidenceScore: 82,
    method: "test",
  },
  market: {
    adsFetched: 12,
    adsAnalyzed: 12,
    comparablesUsed: 8,
    excludedCount: 4,
    medianSimilarity: 0.86,
    priceSpread: 0.16,
    fetchedAt: "2026-08-27T10:00:00.000Z",
  },
  comparables: [],
  excludedAds: [],
  warnings: [],
};

test("expose le tool de cote sur le endpoint MCP Streamable HTTP", async () => {
  let receivedBrand = "";
  let receivedExcludeCompanyVehicles = false;
  let receivedExcludeProfessionalSellers = false;
  let receivedRadiusKm = 0;
  let receivedYearMin = 0;
  let receivedYearMax = 0;
  const app = createMcpHttpApp({
    estimator: async (request) => {
      receivedBrand = request.brand;
      receivedExcludeCompanyVehicles = request.excludeCompanyVehicles ?? false;
      receivedExcludeProfessionalSellers =
        request.excludeProfessionalSellers ?? false;
      receivedRadiusKm = request.location?.radiusKm ?? 0;
      receivedYearMin = request.yearMin ?? 0;
      receivedYearMax = request.yearMax ?? 0;
      return { ...fixture, request };
    },
  });
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "mcp-search-auto-lbc-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "estimate_used_vehicle"));
    assert.ok(tools.tools.some((tool) => tool.name === "resolve_leboncoin_vehicle"));
    assert.ok(
      tools.tools.some((tool) => tool.name === "list_leboncoin_vehicle_brands"),
    );
    assert.ok(
      tools.tools.some((tool) => tool.name === "list_leboncoin_vehicle_models"),
    );
    assert.ok(
      tools.tools.some((tool) => tool.name === "list_leboncoin_vehicle_trims"),
    );

    const resolution = await client.callTool({
      name: "resolve_leboncoin_vehicle",
      arguments: {
        brand: "Renault",
        model: "Clio III",
        fuel: "gasoil",
        discoverFromLeboncoin: false,
      },
    });
    assert.equal(
      (resolution.structuredContent as { leboncoinModel: string }).leboncoinModel,
      "RENAULT_Clio",
    );

    const response = await client.callTool({
      name: "estimate_used_vehicle",
      arguments: {
        brand: "Renault",
        model: "Clio",
        leboncoinBrand: "RENAULT",
        leboncoinModel: "RENAULT_Clio",
        generation: "3",
        year: 2010,
        yearMin: 2009,
        yearMax: 2011,
        mileage: 100_000,
        fuel: "diesel",
        excludeCompanyVehicles: true,
        location: {
          city: "Saintes",
          latitude: 45.746,
          longitude: -0.633,
          radiusKm: 200,
        },
      },
    });

    assert.notEqual(response.isError, true);
    assert.equal(receivedBrand, "Renault");
    assert.equal(receivedExcludeCompanyVehicles, true);
    assert.equal(receivedExcludeProfessionalSellers, true);
    assert.equal(receivedRadiusKm, 200);
    assert.equal(receivedYearMin, 2009);
    assert.equal(receivedYearMax, 2011);
    assert.equal(
      (response.structuredContent as { valuation: { estimatedPrice: number } })
        .valuation.estimatedPrice,
      5_000,
    );
    assert.ok(
      (response.content as Array<{ type: string; text?: string }>).some(
        (item) =>
          item.type === "text" &&
          item.text?.includes("disponibles dans structuredContent"),
      ),
    );
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error?: Error) => (error ? reject(error) : resolve())),
    );
  }
});
