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
import { resolveLeboncoinVehicleWithDiscovery } from "../src/lib/leboncoin/resolver";

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
  discoverFromLeboncoin: z
    .boolean()
    .default(true)
    .describe("Confirmer les modèles inconnus à partir des attributs d'annonces Leboncoin"),
};

const catalogSchema = {
  version: 1,
  purpose:
    "Format attendu pour le futur catalogue de normalisation marque/modèle/génération/moteur/carburant.",
  brand: {
    id: "renault",
    name: "Renault",
    aliases: ["RENAULT"],
    models: [
      {
        id: "clio",
        name: "Clio",
        aliases: ["Clio III", "Clio 3"],
        generations: [
          {
            id: "clio-3",
            name: "Clio III",
            yearFrom: 2005,
            yearTo: 2014,
            engines: [
              {
                id: "k9k-15-dci-90",
                name: "1.5 dCi 90",
                aliases: ["1.5 DCI", "dCi 90"],
                fuel: "diesel",
                powerHp: 90,
              },
            ],
          },
        ],
      },
    ],
  },
};

function createVehicleMcpServer(estimator: VehicleEstimator): McpServer {
  const server = new McpServer(
    {
      name: "mcp-search-auto-lbc",
      version: "0.1.0",
    },
    {
      instructions:
        "Utilise resolve_leboncoin_vehicle pour normaliser les noms ambigus, puis estimate_used_vehicle pour obtenir une cote automobile française fondée sur des annonces comparables. Fournis autant que possible marque, modèle, génération, année, kilométrage, carburant et moteur. Ne présente jamais la cote comme une expertise garantie.",
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
          "",
          "Données structurées complètes :",
          JSON.stringify(result, null, 2),
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
