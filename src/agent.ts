/**
 * Simulated Alexa+ assistant: an Amazon Bedrock model plans and calls Pantry Pal tools over MCP (Streamable HTTP).
 * Shared by the terminal demo (demo-agent.ts) and the Echo Show-style web app (web.ts).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { bedrock, MODEL_ID } from "./bedrock.js";

export const MCP_URL = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const MAX_STEPS = 8;

const systemPrompt = () => `You are a friendly voice assistant in the style of Alexa+. Today is ${new Date().toDateString()}.
Use the Pantry Pal tools for anything about food, the pantry, recipes, meal plans or shopping.
Answer in 1-2 short spoken sentences. Never read out long lists unless asked; the screen shows the details.
Do not narrate your reasoning; reply only with what Alexa would say out loud.
Photos live in the server's photos folder: pass just the file name (e.g. "fridge.jpg") to scan_groceries.
Never call confirm_grocery_order in the same turn as prepare_grocery_order: read the total, ask, and wait for the user's yes.`;

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  ms: number;
}

export interface TurnResult {
  say: string;
  calls: ToolCall[];
}

export async function connectMcp(clientName: string) {
  const token = process.env.MCP_AUTH_TOKEN?.trim();
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(MCP_URL, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    }),
  );
  const { tools } = await client.listTools();
  // MCP tool schemas map 1:1 onto Bedrock Converse toolSpecs.
  const toolConfig = {
    tools: tools.map((t) => ({
      toolSpec: { name: t.name, description: t.description ?? t.name, inputSchema: { json: t.inputSchema } },
    })) as unknown as Tool[],
  };
  return { client, toolConfig, toolCount: tools.length };
}

/** Nova sometimes wraps replies in <thinking>/<response> tags; keep only what Alexa would say. */
export function cleanSpeech(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?response>/gi, "")
    .trim();
}

export class Assistant {
  private messages: Message[] = [];

  constructor(
    private readonly client: Client,
    private readonly toolConfig: { tools: Tool[] },
  ) {}

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolCall> {
    const started = Date.now();
    try {
      const result = await this.client.callTool({ name, arguments: input });
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
      return { name, input, result: text, isError: Boolean(result.isError), ms: Date.now() - started };
    } catch (err) {
      return { name, input, result: (err as Error).message, isError: true, ms: Date.now() - started };
    }
  }

  async turn(userText: string, onCall?: (call: ToolCall) => void): Promise<TurnResult> {
    const calls: ToolCall[] = [];
    // Converse needs alternating roles; if a previous turn failed mid-way, merge into the pending user message.
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") last.content = [...(last.content ?? []), { text: userText }];
    else this.messages.push({ role: "user", content: [{ text: userText }] });

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await bedrock().send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: systemPrompt() }],
          messages: this.messages,
          toolConfig: this.toolConfig,
          inferenceConfig: { maxTokens: 800, temperature: 0.3 },
        }),
      );
      const msg = res.output?.message;
      if (!msg) break;
      this.messages.push(msg);

      const toolUses = (msg.content ?? []).flatMap((c) => (c.toolUse ? [c.toolUse] : []));
      if (res.stopReason !== "tool_use" || toolUses.length === 0) {
        return { say: cleanSpeech((msg.content ?? []).map((c) => c.text ?? "").join("")), calls };
      }

      const results: ContentBlock[] = [];
      for (const use of toolUses) {
        const call = await this.callTool(use.name ?? "", (use.input ?? {}) as Record<string, unknown>);
        calls.push(call);
        onCall?.(call);
        results.push({
          toolResult: { toolUseId: use.toolUseId!, content: [{ text: call.isError ? `ERROR: ${call.result}` : call.result }] },
        });
      }
      this.messages.push({ role: "user", content: results });
    }
    return { say: "Sorry, that took too many steps. Could you try again?", calls };
  }
}
