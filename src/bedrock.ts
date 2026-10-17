import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { describe, type Feedback, type HouseholdProfile, type PantryItem } from "./store.js";

export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0";

let client: BedrockRuntimeClient | undefined;

/** Shared Bedrock Runtime client. Credentials come from the standard AWS provider chain. */
export function bedrock(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  return client;
}

async function converse(system: string, content: ContentBlock[], maxTokens: number): Promise<string> {
  const res = await bedrock().send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: system }],
      messages: [{ role: "user", content }],
      inferenceConfig: { maxTokens, temperature: 0.3 },
    }),
  );
  return (res.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
}

function extractJsonArray(text: string): unknown[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("Model did not return a JSON array");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Model did not return a JSON array");
  return parsed;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ---------- Recipes ----------

export interface Recipe {
  name: string;
  minutes: number;
  servings: number;
  uses: string[];
  missing: string[];
  steps: string[];
}

const RECIPE_SYSTEM = `You are a home-cooking assistant that powers a voice assistant.
Your goal is to reduce food waste: always prioritise pantry items that expire soonest.
Assume salt, pepper, cooking oil and water are always available.
Each recipe may need at most 3 ingredients that are not in the pantry.
NEVER use an ingredient the household is allergic to. Avoid their dislikes.
Learn from past feedback: repeat what they loved, avoid what they disliked.
Respond with ONLY a JSON array, no prose, matching:
[{"name": string, "minutes": number, "servings": number, "uses": string[], "missing": string[], "steps": string[]}]
"uses" lists pantry items used, "missing" lists ingredients to buy, "steps" has at most 6 short steps.`;

// The prompt says these are always available, but models sometimes list them anyway.
const STAPLES = new Set(["salt", "pepper", "black pepper", "salt and pepper", "oil", "cooking oil", "olive oil", "vegetable oil", "water"]);

export async function generateRecipes(opts: {
  pantry: PantryItem[];
  profile: HouseholdProfile;
  feedback: Feedback[];
  servings: number;
  count: number;
  meal?: string;
  dietary?: string;
  maxMinutes?: number;
}): Promise<Recipe[]> {
  const { profile, feedback } = opts;
  const household = [
    `Household: ${profile.people} people.`,
    profile.diet && `Household diet: ${profile.diet}.`,
    profile.allergies.length && `ALLERGIES (never use): ${profile.allergies.join(", ")}.`,
    profile.dislikes.length && `Dislikes (avoid): ${profile.dislikes.join(", ")}.`,
    profile.notes && `Notes: ${profile.notes}.`,
    feedback.length &&
      `Past feedback:\n${feedback.map((f) => `- ${f.rating}: ${f.recipe}${f.note ? ` (${f.note})` : ""}`).join("\n")}`,
  ].filter(Boolean);

  const constraints = [
    `Suggest ${opts.count} recipe${opts.count === 1 ? "" : "s"} for ${opts.servings} serving${opts.servings === 1 ? "" : "s"}.`,
    opts.meal && `Meal: ${opts.meal}.`,
    opts.dietary && `Extra dietary requirements for this meal: ${opts.dietary}.`,
    opts.maxMinutes && `Must take at most ${opts.maxMinutes} minutes.`,
  ].filter(Boolean);

  const prompt = [
    `Pantry (soonest expiry first):\n${opts.pantry.map((p) => `- ${describe(p)}`).join("\n")}`,
    household.join("\n"),
    constraints.join("\n"),
  ].join("\n\n");

  const recipes = extractJsonArray(await converse(RECIPE_SYSTEM, [{ text: prompt }], 1500))
    .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.name === "string")
    .map((r) => ({
      name: String(r.name),
      minutes: Number(r.minutes) || 30,
      servings: Number(r.servings) || opts.servings,
      uses: strings(r.uses),
      missing: strings(r.missing).filter((m) => !STAPLES.has(m.trim().toLowerCase())),
      steps: strings(r.steps).slice(0, 6),
    }));

  // Safety net: never return a recipe that mentions an allergen, even if the model slipped.
  const allergens = profile.allergies.map((a) => a.toLowerCase());
  return recipes.filter((r) => {
    const text = [r.name, ...r.uses, ...r.missing, ...r.steps].join(" ").toLowerCase();
    return !allergens.some((a) => text.includes(a));
  });
}

// ---------- Vision: scan a fridge, pantry shelf or receipt ----------

export type ImageFormat = "png" | "jpeg" | "gif" | "webp";
export type ScanSource = "fridge" | "pantry" | "receipt";

export interface ScannedItem {
  name: string;
  quantity: number;
  unit?: string;
  expiresInDays?: number;
}

const SCAN_SYSTEM = `You catalogue food for a kitchen inventory app.
List every distinct food or drink item you can identify. Ignore non-food items.
For each item estimate the quantity, a unit (or null for countable items) and how many days until it typically
expires from today if stored normally (null for shelf-stable items such as rice, pasta, cans, spices).
Use short, common names as a shopper would say them (e.g. "eggs", "spinach", "milk").
Respond with ONLY a JSON array, no prose, matching:
[{"name": string, "quantity": number, "unit": string | null, "expires_in_days": number | null}]`;

const SCAN_HINT: Record<ScanSource, string> = {
  fridge: "This is a photo of the inside of a fridge.",
  pantry: "This is a photo of a pantry shelf or kitchen counter.",
  receipt: "This is a grocery receipt. Read the purchased food items and quantities; assume they were bought today.",
};

export async function scanGroceries(bytes: Uint8Array, format: ImageFormat, source: ScanSource): Promise<ScannedItem[]> {
  const text = await converse(
    SCAN_SYSTEM,
    [{ image: { format, source: { bytes } } }, { text: `${SCAN_HINT[source]} List the food items.` }],
    1500,
  );
  return extractJsonArray(text)
    .filter((i): i is Record<string, unknown> => isObject(i) && typeof i.name === "string" && i.name.trim() !== "")
    .map((i) => ({
      name: String(i.name).trim(),
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      unit: typeof i.unit === "string" && i.unit.trim() ? i.unit.trim() : undefined,
      expiresInDays:
        typeof i.expires_in_days === "number" && i.expires_in_days >= 0 ? Math.round(i.expires_in_days) : undefined,
    }));
}
