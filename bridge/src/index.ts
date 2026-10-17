/**
 * mcp-bedrock-bridge: use any MCP server's tools with the Amazon Bedrock Converse API.
 *
 * - mcpToolsToBedrock(): MCP tool list -> Bedrock toolConfig (name sanitising, de-duplication, schema clean-up)
 * - mcpResultToToolResult(): MCP CallToolResult -> Bedrock toolResult block (text, images, structured content, errors)
 * - BedrockMcpAgent: a tool-use loop that lets a Bedrock model call MCP tools until it answers
 */
import {
  ConverseCommand,
  type BedrockRuntimeClient,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type Tool,
  type ToolConfiguration,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

// ---------- Minimal structural interfaces (easy to mock in tests) ----------

/** Anything that can list and call MCP tools, e.g. the MCP SDK `Client`. */
export interface McpToolSource {
  listTools(params?: { cursor?: string }): Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

/** Anything that can send a ConverseCommand, e.g. `BedrockRuntimeClient`. */
export interface ConverseSender {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
}

// ---------- Tool mapping ----------

const MAX_NAME = 64; // Bedrock tool names: ^[a-zA-Z0-9_-]{1,64}$

/** Converts an MCP tool name (which may contain dots, slashes, etc.) into a valid Bedrock tool name. */
export function toBedrockToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_NAME);
  return cleaned || "tool";
}

export interface ToolMapping {
  toolConfig: ToolConfiguration;
  /** Bedrock tool name -> original MCP tool name. */
  toMcpName: Map<string, string>;
}

export function mcpToolsToBedrock(tools: McpTool[]): ToolMapping {
  const toMcpName = new Map<string, string>();
  const specs: Tool[] = [];
  for (const t of tools) {
    const base = toBedrockToolName(t.name);
    let name = base;
    for (let n = 2; toMcpName.has(name); n++) {
      const suffix = `_${n}`;
      name = base.slice(0, MAX_NAME - suffix.length) + suffix;
    }
    toMcpName.set(name, t.name);

    // "$schema" is not needed by Bedrock and some models reject unknown top-level keywords.
    const { $schema: _ignored, ...schema } = (t.inputSchema ?? {}) as Record<string, unknown>;
    const description = (t.description || t.title || t.name).trim() || t.name;
    specs.push({
      toolSpec: { name, description, inputSchema: { json: { type: "object", properties: {}, ...schema } } },
    } as Tool);
  }
  return { toolConfig: { tools: specs }, toMcpName };
}

// ---------- Result conversion ----------

type BedrockImageFormat = "png" | "jpeg" | "gif" | "webp";
const IMAGE_FORMATS: Record<string, BedrockImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

interface McpContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

/**
 * Converts an MCP CallToolResult into a Bedrock `toolResult` content block.
 * `includeStatus` adds Bedrock's `status` field; not every model supports it, so by default
 * errors are signalled with an "ERROR:" prefix instead.
 */
export function mcpResultToToolResult(
  toolUseId: string,
  result: unknown,
  opts: { includeStatus?: boolean } = {},
): ContentBlock {
  const r = (result ?? {}) as { content?: McpContentItem[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };
  const content: ToolResultContentBlock[] = [];

  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") {
      content.push({ text: c.text });
    } else if (c.type === "image" && c.data) {
      const format = IMAGE_FORMATS[(c.mimeType ?? "").toLowerCase()];
      content.push(
        format
          ? { image: { format, source: { bytes: new Uint8Array(Buffer.from(c.data, "base64")) } } }
          : { text: `[image omitted: ${c.mimeType ?? "unknown type"} is not supported by Bedrock]` },
      );
    } else if (c.type === "resource" && c.resource) {
      content.push({ text: c.resource.text ?? `[resource ${c.resource.uri ?? ""}]` });
    } else if (c.type === "resource_link") {
      content.push({ text: `[resource link ${c.uri ?? ""}]` });
    } else if (c.type === "audio") {
      content.push({ text: "[audio omitted]" });
    }
  }
  if (r.structuredContent && typeof r.structuredContent === "object") {
    content.push({ json: r.structuredContent } as ToolResultContentBlock);
  }
  // Older servers may return the legacy `{ toolResult }` shape.
  if (!content.length && r.toolResult !== undefined) content.push({ text: JSON.stringify(r.toolResult) });
  if (!content.length) content.push({ text: "(no content)" });

  if (r.isError && !opts.includeStatus) {
    const first = content[0];
    if ("text" in first && typeof first.text === "string") content[0] = { text: `ERROR: ${first.text}` };
    else content.unshift({ text: "ERROR:" });
  }

  return {
    toolResult: {
      toolUseId,
      content,
      ...(opts.includeStatus ? { status: r.isError ? "error" : "success" } : {}),
    },
  } as ContentBlock;
}

/** Removes reasoning wrappers some models emit (e.g. Amazon Nova's <thinking> and <response> tags). */
export function cleanModelText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?response>/gi, "")
    .trim();
}

// ---------- Agent loop ----------

export interface ToolCallRecord {
  /** Original MCP tool name. */
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  ms: number;
}

export interface RunResult {
  text: string;
  toolCalls: ToolCallRecord[];
  stopReason?: string;
  steps: number;
}

export interface BedrockMcpAgentOptions {
  mcp: McpToolSource;
  bedrock: BedrockRuntimeClient | ConverseSender;
  modelId: string;
  /** System prompt, or a function so it can include fresh context such as today's date. */
  system?: string | (() => string);
  /** Maximum model calls per run (default 8). */
  maxSteps?: number;
  inferenceConfig?: ConverseCommandInput["inferenceConfig"];
  /** Send Bedrock's toolResult `status` field (default false; not all models accept it). */
  includeToolStatus?: boolean;
  /** Only expose some MCP tools to the model. */
  toolFilter?: (tool: McpTool) => boolean;
  onToolCall?: (call: ToolCallRecord) => void;
}

export class BedrockMcpAgent {
  /** Full conversation history in Bedrock Converse format. */
  readonly messages: Message[] = [];
  private mapping?: ToolMapping;

  constructor(private readonly opts: BedrockMcpAgentOptions) {}

  /** Lists MCP tools (following pagination) and builds the Bedrock tool config. Called lazily by run(). */
  async init(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.opts.mcp.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const selected = this.opts.toolFilter ? tools.filter(this.opts.toolFilter) : tools;
    this.mapping = mcpToolsToBedrock(selected);
    return selected;
  }

  reset(): void {
    this.messages.length = 0;
  }

  async run(userText: string): Promise<RunResult> {
    if (!this.mapping) await this.init();
    const mapping = this.mapping!;
    const maxSteps = this.opts.maxSteps ?? 8;
    const toolCalls: ToolCallRecord[] = [];

    // Converse requires alternating roles; merge into a dangling user message left by a failed run.
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") last.content = [...(last.content ?? []), { text: userText }];
    else this.messages.push({ role: "user", content: [{ text: userText }] });

    for (let step = 1; step <= maxSteps; step++) {
      const system = typeof this.opts.system === "function" ? this.opts.system() : this.opts.system;
      const out = await (this.opts.bedrock as ConverseSender).send(
        new ConverseCommand({
          modelId: this.opts.modelId,
          messages: this.messages,
          ...(system ? { system: [{ text: system }] } : {}),
          ...(mapping.toolConfig.tools?.length ? { toolConfig: mapping.toolConfig } : {}),
          ...(this.opts.inferenceConfig ? { inferenceConfig: this.opts.inferenceConfig } : {}),
        }),
      );
      const msg = out.output?.message;
      if (!msg) return { text: "", toolCalls, stopReason: out.stopReason, steps: step };
      this.messages.push(msg);

      const uses = (msg.content ?? []).flatMap((c) => (c.toolUse ? [c.toolUse] : []));
      if (out.stopReason !== "tool_use" || uses.length === 0) {
        const text = cleanModelText((msg.content ?? []).map((c) => c.text ?? "").join(""));
        return { text, toolCalls, stopReason: out.stopReason, steps: step };
      }

      const results: ContentBlock[] = [];
      for (const use of uses) {
        const bedrockName = use.name ?? "";
        const name = mapping.toMcpName.get(bedrockName) ?? bedrockName;
        const input = (use.input ?? {}) as Record<string, unknown>;
        const started = Date.now();
        let result: unknown;
        try {
          result = await this.opts.mcp.callTool({ name, arguments: input });
        } catch (err) {
          result = { content: [{ type: "text", text: (err as Error).message }], isError: true };
        }
        const record: ToolCallRecord = {
          name,
          input,
          result,
          isError: Boolean((result as { isError?: boolean } | undefined)?.isError),
          ms: Date.now() - started,
        };
        toolCalls.push(record);
        this.opts.onToolCall?.(record);
        results.push(mcpResultToToolResult(use.toolUseId ?? "", result, { includeStatus: this.opts.includeToolStatus }));
      }
      this.messages.push({ role: "user", content: results });
    }
    return { text: "", toolCalls, stopReason: "max_steps", steps: maxSteps };
  }
}
