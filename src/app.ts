/**
 * The Pantry Pal MCP HTTP app (Express). Used by:
 * - server.ts: local process, listens on HOST:PORT
 * - lambda.ts: AWS Lambda behind a Function URL
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./mcp.js";
import { MODEL_ID } from "./bedrock.js";
import { DEFAULT_HOUSEHOLD, runWithHousehold } from "./context.js";
import { persistence } from "./persistence.js";
import { readFileSync } from "node:fs";
import path from "node:path";

// Written by the deploy workflow so /health can confirm which commit is live.
function buildInfo(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.resolve("dist/build.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { sha: "dev" };
  }
}
const BUILD = buildInfo();
const ON_LAMBDA = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const maskKey = (url: string) => url.replace(/\/h\/[^/]+\/mcp/, "/h/***/mcp");

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();
// Multi-household mode: HOUSEHOLD_KEYS="<bearer-key>:<household-id>,<bearer-key>:<household-id>"
const HOUSEHOLD_KEYS = new Map(
  (process.env.HOUSEHOLD_KEYS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      return idx === -1 ? [pair, pair] : [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()];
    }),
);
const AUTH_REQUIRED = Boolean(AUTH_TOKEN) || HOUSEHOLD_KEYS.size > 0;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Lambda buffers the whole response, so answer POSTs with plain JSON there instead of an SSE stream.
const JSON_RESPONSE = process.env.MCP_JSON_RESPONSE === "true" || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

export const authMode = (): string =>
  AUTH_REQUIRED ? (HOUSEHOLD_KEYS.size ? `${HOUSEHOLD_KEYS.size} household key(s)` : "token") : "off";

/**
 * Credential for a request: `Authorization: Bearer <key>`, or the key embedded in the path
 * (`/h/<key>/mcp`) for hosts such as ChatGPT connectors that cannot send custom headers.
 */
function credentialOf(req: Request): string {
  const inPath = /^\/h\/([^/]+)\/mcp(?:\/|$|\?)/.exec(req.originalUrl ?? req.url ?? "");
  if (inPath) return decodeURIComponent(inPath[1]);
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

/** Returns the household for a credential, or undefined when it is missing/invalid. */
function resolveHousehold(token: string): string | undefined {
  if (!AUTH_REQUIRED) return DEFAULT_HOUSEHOLD;
  if (!token) return undefined;
  const mapped = HOUSEHOLD_KEYS.get(token);
  if (mapped) return mapped;
  return AUTH_TOKEN && token === AUTH_TOKEN ? DEFAULT_HOUSEHOLD : undefined;
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function createApp() {
  const app = express();

  // Behind the Lambda Function URL adapter, header names can arrive non-lowercased, which makes
  // express.json() and the MCP transport miss Content-Type ("Unsupported Media Type"). Normalise them,
  // and default MCP POSTs to JSON, the only content type Streamable HTTP allows.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower !== key && value !== undefined && req.headers[lower] === undefined) req.headers[lower] = value;
    }
    if (req.method === "POST" && /\/mcp(?:\/|$|\?)/.test(req.url) && !req.headers["content-type"]) {
      req.headers["content-type"] = "application/json";
    }
    next();
  });

  // Large enough for a base64-encoded 3.75 MB photo sent to scan_groceries.
  app.use(express.json({ limit: "8mb" }));

  app.get("/health", (req: Request, res: Response) => {
    res.json({
      ok: true,
      protocolVersion: LATEST_PROTOCOL_VERSION,
      model: MODEL_ID,
      store: persistence.kind,
      auth: AUTH_REQUIRED ? (HOUSEHOLD_KEYS.size ? "household-keys" : "token") : "none",
      runtime: ON_LAMBDA ? "lambda" : "node",
      build: BUILD,
      // Diagnostics: shows header names exactly as the app receives them (values omitted except content-type/accept).
      ...(req.query.echo
        ? {
            receivedHeaderNames: Object.keys(req.headers),
            contentType: req.headers["content-type"] ?? null,
            accept: req.headers.accept ?? null,
          }
        : {}),
    });
  });

  // Both endpoints serve the same MCP server: /mcp (bearer header) and /h/<key>/mcp (key in the URL).
  const MCP_PATHS = ["/mcp", "/h/:key/mcp"];

  // Security required by the Streamable HTTP spec: validate Origin (DNS rebinding) and require credentials.
  app.use(MCP_PATHS, (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      jsonRpcError(res, 403, `Origin not allowed: ${origin}`);
      return;
    }
    const household = resolveHousehold(credentialOf(req));
    if (!household) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="pantry-pal"');
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }
    res.locals.household = household;
    next();
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, shared data store underneath.
  app.post(MCP_PATHS, async (req: Request, res: Response) => {
    if (ON_LAMBDA) {
      console.log(
        JSON.stringify({
          mcpPost: maskKey(req.originalUrl ?? req.url),
          headerNames: Object.keys(req.headers),
          contentType: req.headers["content-type"] ?? null,
          bodyType: typeof req.body,
          bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : null,
        }),
      );
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: JSON_RESPONSE });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // Everything below (including tool handlers) sees this household via the store's request context.
      await runWithHousehold(String(res.locals.household ?? DEFAULT_HOUSEHOLD), async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, "Method not allowed");
  };
  app.get(MCP_PATHS, methodNotAllowed);
  app.delete(MCP_PATHS, methodNotAllowed);

  return app;
}
