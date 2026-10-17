import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, type PantryItem } from "./store.js";

export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0";

let client: BedrockRuntimeClient | undefined;

/** Shared Bedrock Runtime client. Credentials come from the standard AWS provider chain. */
export function bedrock(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  return client;
}

export interface Recipe {
  name: string;
  minutes: number;
  servings: number;
  uses: string[];
  missing: string[];
  steps: string[];
}

const SYSTEM_PROMPT = `You are a home-cooking assistant that powers a voice assistant.
Your goal is to reduce food waste: always prioritise pantry items that expire soonest.
Assume salt, pepper, cooking oil and water are always available.
Each recipe may need at most 3 ingredients that are not in the pantry.
Respond with ONLY a JSON array, no prose, matching:
[{"name": string, "minutes": number, "servings": number, "uses": string[], "missing": string[], "steps": string[]}]
"uses" lists pantry items used, "missing" lists ingredients to buy, "steps" has at most 6 short steps.`;

export async function generateRecipes(opts: {
  pantry: PantryItem[];
  servings: number;
  count: number;
  meal?: string;
  dietary?: string;
  maxMinutes?: number;
}): Promise<Recipe[]> {
  const constraints = [
    `Suggest ${opts.count} recipe${opts.count === 1 ? "" : "s"} for ${opts.servings} serving${opts.servings === 1 ? "" : "s"}.`,
    opts.meal && `Meal: ${opts.meal}.`,
    opts.dietary && `Dietary requirements: ${opts.dietary}.`,
    opts.maxMinutes && `Must take at most ${opts.maxMinutes} minutes.`,
  ].filter(Boolean);

  const prompt = `Pantry (soonest expiry first):\n${opts.pantry.map((p) => `- ${describe(p)}`).join("\n")}\n\n${constraints.join("\n")}`;

  const res = await bedrock().send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1200, temperature: 0.4 },
    }),
  );

  const text = (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
  return parseRecipes(text);
}

function parseRecipes(text: string): Recipe[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Model did not return a JSON array");
  const raw = JSON.parse(match[0]) as unknown[];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && typeof (r as any).name === "string")
    .map((r) => ({
      name: String(r.name),
      minutes: Number(r.minutes) || 30,
      servings: Number(r.servings) || 2,
      uses: strings(r.uses),
      missing: strings(r.missing),
      steps: strings(r.steps).slice(0, 6),
    }));
}
