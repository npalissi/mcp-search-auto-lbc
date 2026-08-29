import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import {
  estimateUsedVehicle,
  type AdvancedVehicleValuation,
  type VehicleValuationRequest,
} from "../src/lib/leboncoin/advanced-valuation";
import {
  getLeboncoinVehicleCatalogViaPython,
  getLeboncoinVehicleTrimsViaPython,
} from "../src/lib/leboncoin/client";
import { resolveLeboncoinVehicleWithDiscovery } from "../src/lib/leboncoin/resolver";
import type {
  LeboncoinCatalogOption,
  LeboncoinVehicleCatalogBrand,
} from "../src/lib/leboncoin/types";

type TransportRequest = Parameters<StreamableHTTPServerTransport["handleRequest"]>[0];
type TransportResponse = Parameters<StreamableHTTPServerTransport["handleRequest"]>[1];
type ExpressRequest = TransportRequest & {
  body: unknown;
  headers: TransportRequest["headers"] & { authorization?: string };
};
type ExpressResponse = TransportResponse & {
  headersSent: boolean;
  json: (body: unknown) => unknown;
  status: (code: number) => ExpressResponse;
};

export type VehicleEstimator = (
  request: VehicleValuationRequest,
) => Promise<AdvancedVehicleValuation>;

export type McpHttpOptions = {
  estimator?: VehicleEstimator;
  host?: string;
  apiToken?: string;
  allowedHosts?: string[];
};

const vehicleInputSchema = {
  brand: z.string().trim().min(1).describe("Marque normalisée, par exemple Renault"),
  model: z.string().trim().min(1).describe("Modèle de base, par exemple Clio"),
  leboncoinBrand: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Valeur exacte du filtre Leboncoin u_car_brand, par exemple RENAULT"),
  leboncoinModel: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Valeur exacte du filtre Leboncoin u_car_model, par exemple RENAULT_Clio",
    ),
  generation: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Génération, par exemple 3, III ou Phase 2"),
  year: z.number().int().min(1980).max(new Date().getFullYear() + 1),
  mileage: z.number().int().min(0).max(1_500_000),
  fuel: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Carburant, par exemple diesel, essence, hybride ou électrique"),
  engine: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Motorisation exacte, par exemple 1.5 dCi 90"),
  gearbox: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Boîte manuelle ou automatique"),
  trim: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Finition, par exemple Intens"),
  excludeCompanyVehicles: z
    .boolean()
    .default(false)
    .describe(
      "Exclure les véhicules de société, versions Affaire/Entreprise, 2 places et annonces avec TVA récupérable",
    ),
  excludeProfessionalSellers: z
    .boolean()
    .default(true)
    .describe("Exclure les annonces publiées par des vendeurs professionnels"),
  location: z
    .object({
      city: z.string().trim().min(1).optional(),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusKm: z.number().int().min(1).max(200),
    })
    .optional()
    .describe(
      "Zone de recherche Leboncoin autour d'un point, avec un rayon de 1 à 200 km",
    ),
  maxComparables: z.number().int().min(5).max(35).default(20),
  includeDescriptions: z.boolean().default(true),
  includeImages: z.boolean().default(true),
  descriptionMaxChars: z.number().int().min(200).max(5_000).default(1_200),
};

const resolverInputSchema = {
  brand: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Marque telle qu'exprimée par l'utilisateur, par exemple Renault ou VW"),
  model: z
    .string()
    .trim()
    .min(1)
    .describe("Modèle naturel, éventuellement avec génération, par exemple Clio III"),
  generation: z.string().trim().min(1).optional(),
  fuel: z.string().trim().min(1).optional(),
  engine: z.string().trim().min(1).optional(),
  trim: z.string().trim().min(1).optional(),
  discoverFromLeboncoin: z
    .boolean()
    .default(true)
    .describe("Confirmer les modèles inconnus à partir des attributs d'annonces Leboncoin"),
};

const catalogQuerySchema = {
  query: z.string().trim().optional(),
  limit: z.number().int().min(1).max(200).default(50),
};

const catalogModelsSchema = {
  brand: z
    .string()
    .trim()
    .min(1)
    .describe("Marque naturelle ou identifiant Leboncoin, par exemple Citroën ou CITROEN"),
  ...catalogQuerySchema,
};

const catalogTrimsSchema = {
  leboncoinModel: z
    .string()
    .trim()
    .min(1)
    .describe("Identifiant exact Leboncoin du modèle, par exemple CITROEN_C3"),
  ...catalogQuerySchema,
};

const catalogSchema = {
  version: 1,
  purpose:
    "Structure du catalogue marques/modèles synchronisé depuis les données frontend Leboncoin.",
  cacheStatus: "fresh | refreshed | stale",
  fetchedAt: "ISO-8601",
  brands: [
    {
      value: "RENAULT",
      label: "RENAULT",
      models: [
        {
          value: "RENAULT_Clio",
          label: "Clio",
        },
      ],
    },
  ],
};

function normalizeCatalogText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchingOptions(
  options: LeboncoinCatalogOption[],
  query: string | undefined,
  limit: number,
): LeboncoinCatalogOption[] {
  const normalizedQuery = normalizeCatalogText(query ?? "");
  return options
    .filter(
      (option) =>
        !normalizedQuery ||
        normalizeCatalogText(option.value).includes(normalizedQuery) ||
        normalizeCatalogText(option.label).includes(normalizedQuery),
    )
    .slice(0, limit);
}

function findCatalogBrand(
  brands: LeboncoinVehicleCatalogBrand[],
  value: string,
): LeboncoinVehicleCatalogBrand | undefined {
  const normalized = normalizeCatalogText(value);
  return brands.find(
    (brand) =>
      normalizeCatalogText(brand.value) === normalized ||
      normalizeCatalogText(brand.label) === normalized,
  );
}

function createVehicleMcpServer(estimator: VehicleEstimator): McpServer {
  const server = new McpServer(
    {
      name: "mcp-search-auto-lbc",
      version: "0.1.0",
    },
    {
      instructions:
        "Utilise resolve_leboncoin_vehicle pour normaliser les noms ambigus depuis le catalogue Leboncoin, puis estimate_used_vehicle pour obtenir une cote automobile française fondée sur des annonces comparables. Les tools list_leboncoin_vehicle_* servent à explorer les marques, modèles et finitions lorsque l'utilisateur le demande ou qu'une ambiguïté subsiste. Fournis autant que possible marque, modèle, génération, année, kilométrage, carburant et moteur. Ne présente jamais la cote comme une expertise garantie.",
    },
  );

  server.registerTool(
    "list_leboncoin_vehicle_brands",
    {
      title: "Lister les marques automobiles Leboncoin",
      description:
        "Retourne les marques du catalogue actuellement publié par Leboncoin. Utiliser query pour limiter la réponse au lieu de charger tout le catalogue dans le contexte.",
      inputSchema: catalogQuerySchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      const catalog = await getLeboncoinVehicleCatalogViaPython();
      const brands = matchingOptions(
        catalog.brands.map(({ value, label }) => ({ value, label })),
        query,
        limit,
      );
      const result = {
        query,
        total: brands.length,
        sourceVersion: catalog.sourceVersion,
        fetchedAt: catalog.fetchedAt,
        cacheStatus: catalog.cacheStatus,
        brands,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_leboncoin_vehicle_models",
    {
      title: "Lister les modèles automobiles Leboncoin",
      description:
        "Retourne les identifiants exacts u_car_model pour une marque du catalogue Leboncoin.",
      inputSchema: catalogModelsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ brand, query, limit }) => {
      const catalog = await getLeboncoinVehicleCatalogViaPython();
      const catalogBrand = findCatalogBrand(catalog.brands, brand);
      if (!catalogBrand) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Marque absente du catalogue Leboncoin : ${brand}`,
            },
          ],
        };
      }
      const models = matchingOptions(catalogBrand.models, query, limit);
      const result = {
        brand: { value: catalogBrand.value, label: catalogBrand.label },
        query,
        total: models.length,
        fetchedAt: catalog.fetchedAt,
        cacheStatus: catalog.cacheStatus,
        models,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "list_leboncoin_vehicle_trims",
    {
      title: "Lister les finitions automobiles Leboncoin",
      description:
        "Retourne les identifiants exacts u_car_finition pour un u_car_model Leboncoin.",
      inputSchema: catalogTrimsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ leboncoinModel, query, limit }) => {
      const trims = await getLeboncoinVehicleTrimsViaPython(leboncoinModel);
      const values = matchingOptions(trims.values, query, limit);
      const result = {
        leboncoinModel,
        query,
        total: values.length,
        fetchedAt: trims.fetchedAt,
        cacheStatus: trims.cacheStatus,
        trims: values,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "resolve_leboncoin_vehicle",
    {
      title: "Résoudre les identifiants véhicule Leboncoin",
      description:
        "Convertit une marque, un modèle, une génération et un carburant exprimés naturellement vers les valeurs exactes u_car_brand, u_car_model et fuel de Leboncoin. Retourne un score de confiance, des avertissements et des alternatives.",
      inputSchema: resolverInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const result = await resolveLeboncoinVehicleWithDiscovery(input);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "estimate_used_vehicle",
    {
      title: "Estimer la cote d'un véhicule d'occasion",
      description:
        "Recherche des annonces automobiles comparables en France, exclut les annonces trompeuses ou non comparables, puis retourne une cote et les preuves détaillées : titre, prix, description, caractéristiques, images, URL et score de similarité.",
      inputSchema: vehicleInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const result = await estimator(input);
        const textSummary = [
          `Cote estimée : ${result.valuation.estimatedPrice.toLocaleString("fr-FR")} €`,
          `Fourchette : ${result.valuation.lowPrice.toLocaleString("fr-FR")}–${result.valuation.highPrice.toLocaleString("fr-FR")} €`,
          `Confiance : ${result.valuation.confidence} (${result.valuation.confidenceScore}/100)`,
          `Comparables retenus : ${result.market.comparablesUsed} sur ${result.market.adsFetched} annonces`,
          "Les annonces et toutes leurs données sont disponibles dans structuredContent.",
        ].join("\n");

        return {
          content: [{ type: "text" as const, text: textSummary }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[MCP] Vehicle valuation failed:", error);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `La recherche de cote a échoué : ${message}`,
            },
          ],
        };
      }
    },
  );

  server.registerResource(
    "vehicle-catalog-schema",
    "vehicle://catalog/schema",
    {
      title: "Schéma du catalogue automobile",
      description:
        "Exemple du format de données marque, modèle, génération, moteur et carburant.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(catalogSchema, null, 2),
        },
      ],
    }),
  );

  return server;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function unauthorized(res: {
  status: (code: number) => { json: (body: unknown) => unknown };
}): unknown {
  return res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Bearer token required." },
    id: null,
  });
}

export function createMcpHttpApp(options: McpHttpOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const estimator = options.estimator ?? estimateUsedVehicle;
  const apiToken = options.apiToken;

  if (!isLoopback(host) && !apiToken) {
    throw new Error(
      "MCP_API_TOKEN is required when MCP_HOST is exposed outside localhost.",
    );
  }

  const app = createMcpExpressApp({
    host,
    ...(options.allowedHosts?.length
      ? { allowedHosts: options.allowedHosts }
      : {}),
  });

  app.get("/health", (_req: ExpressRequest, res: ExpressResponse) => {
    res.json({
      status: "ok",
      service: "mcp-search-auto-lbc",
      endpoint: "/mcp",
      transport: "streamable-http",
    });
  });

  app.post("/mcp", async (req: ExpressRequest, res: ExpressResponse) => {
    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) {
      unauthorized(res);
      return;
    }

    const server = createVehicleMcpServer(estimator);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[MCP] Request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error." },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  const methodNotAllowed = (_req: unknown, res: {
    status: (code: number) => { json: (body: unknown) => unknown };
  }) =>
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}

export function startMcpHttpServer(options: McpHttpOptions = {}) {
  const host = options.host ?? process.env.MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.MCP_PORT ?? 3100);
  const apiToken = options.apiToken ?? process.env.MCP_API_TOKEN;
  const allowedHosts =
    options.allowedHosts ??
    process.env.MCP_ALLOWED_HOSTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  const app = createMcpHttpApp({ ...options, host, apiToken, allowedHosts });

  return app.listen(port, host, () => {
    console.error(
      `Vehicle valuation MCP listening on http://${host}:${port}/mcp`,
    );
  });
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entrypoint === import.meta.url) {
  startMcpHttpServer();
}
