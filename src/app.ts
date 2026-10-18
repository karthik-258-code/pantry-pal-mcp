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

/** Returns the household for a request, or undefined when the credentials are missing/invalid. */
function resolveHousehold(authorization: string | undefined): string | undefined {
  if (!AUTH_REQUIRED) return DEFAULT_HOUSEHOLD;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
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
  // Large enough for a base64-encoded 3.75 MB photo sent to scan_groceries.
  app.use(express.json({ limit: "8mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      protocolVersion: LATEST_PROTOCOL_VERSION,
      model: MODEL_ID,
      store: persistence.kind,
      auth: AUTH_REQUIRED ? (HOUSEHOLD_KEYS.size ? "household-keys" : "token") : "none",
      runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? "lambda" : "node",
    });
  });

  // Security required by the Streamable HTTP spec: validate Origin (DNS rebinding) and require credentials.
  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      jsonRpcError(res, 403, `Origin not allowed: ${origin}`);
      return;
    }
    const household = resolveHousehold(req.headers.authorization);
    if (!household) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="pantry-pal"');
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }
    res.locals.household = household;
    next();
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, shared data store underneath.
  app.post("/mcp", async (req: Request, res: Response) => {
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
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
