import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { describe, type Feedback, type HouseholdProfile, type PantryItem, type PlanDay } from "./store.js";

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

/** Pulls a JSON array out of model text: handles code fences, prose around it, and truncated output. */
export function extractJsonArray(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("[");
  if (start !== -1) {
    const candidates: string[] = [];
    const end = cleaned.lastIndexOf("]");
    if (end > start) candidates.push(cleaned.slice(start, end + 1));
    const lastObject = cleaned.lastIndexOf("}");
    if (lastObject > start) candidates.push(`${cleaned.slice(start, lastObject + 1)}]`);
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c) as unknown;
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // try the next candidate
      }
    }
  }
  const preview = cleaned.trim().slice(0, 160).replace(/\s+/g, " ");
  throw new Error(`Model did not return a JSON array (got: "${preview}")`);
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
      missing: strings(r.missing).filter((m) => !STAPLES.has(m.trim().toLowerCase()) && !inPantry(opts.pantry, m)),
      steps: strings(r.steps).slice(0, 6),
    }));

  // Safety net: never return a recipe that mentions an allergen, even if the model slipped.
  // "eggs" must also catch "egg", "peanuts" must catch "peanut", etc.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allergens = profile.allergies.map((a) => {
    const stem = a.trim().toLowerCase().replace(/(es|s)$/, "");
    return new RegExp(`\\b${escapeRe(stem)}(e?s)?\\b`, "i");
  });
  return recipes.filter((r) => {
    const text = [r.name, ...r.uses, ...r.missing, ...r.steps].join(" ");
    return !allergens.some((re) => re.test(text));
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
  const ask = async () =>
    extractJsonArray(
      await converse(
        SCAN_SYSTEM,
        [
          { image: { format, source: { bytes } } },
          { text: `${SCAN_HINT[source]} List the food items (at most 25). Reply with the JSON array only.` },
        ],
        3000,
      ),
    );
  let raw: unknown[];
  try {
    raw = await ask();
  } catch (err) {
    // Vision answers occasionally come back as prose; one retry fixes most of them.
    console.warn(`scan_groceries: retrying after ${(err as Error).message}`);
    raw = await ask();
  }
  return raw
    .filter((i): i is Record<string, unknown> => isObject(i) && typeof i.name === "string" && i.name.trim() !== "")
    .map((i) => ({
      name: String(i.name).trim(),
      quantity: Number(i.quantity) > 0 ? Number(i.quantity) : 1,
      unit: typeof i.unit === "string" && i.unit.trim() ? i.unit.trim() : undefined,
      expiresInDays:
        typeof i.expires_in_days === "number" && i.expires_in_days >= 0 ? Math.round(i.expires_in_days) : undefined,
    }));
}

// ---------- Shared helpers ----------

const FILLER = new Set(["fresh", "cheese", "shredded", "grated", "large", "small", "chopped", "sliced", "dried", "ground", "whole", "boneless", "skinless"]);
const coreWords = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w && !FILLER.has(w))
    .map((w) => w.replace(/(es|s)$/, ""));

/** True if the pantry already holds this ingredient, e.g. "cheddar cheese" vs "cheddar", "chicken" vs "chicken thighs". */
export function inPantry(pantry: PantryItem[], name: string): boolean {
  const want = coreWords(name);
  if (!want.length) return false;
  return pantry.some((p) => {
    const have = coreWords(p.name);
    return have.join(" ") === want.join(" ") || (want.length === 1 && have.includes(want[0]));
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns the first allergy mentioned in the texts, matching singular and plural forms. */
export function findAllergen(profile: HouseholdProfile, texts: string[]): string | undefined {
  const text = texts.join(" ");
  return profile.allergies.find((a) => {
    const stem = a.trim().toLowerCase().replace(/(es|s)$/, "");
    return new RegExp(`\\b${escapeRe(stem)}(e?s)?\\b`, "i").test(text);
  });
}

function householdContext(profile: HouseholdProfile, feedback: Feedback[]): string {
  return [
    `Household: ${profile.people} people.`,
    profile.diet && `Household diet: ${profile.diet}.`,
    profile.allergies.length && `ALLERGIES (never use): ${profile.allergies.join(", ")}.`,
    profile.dislikes.length && `Dislikes (avoid): ${profile.dislikes.join(", ")}.`,
    profile.notes && `Notes: ${profile.notes}.`,
    feedback.length &&
      `Past feedback:\n${feedback.map((f) => `- ${f.rating}: ${f.recipe}${f.note ? ` (${f.note})` : ""}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- Multi-day meal plan ----------

const PLAN_SYSTEM = `You are a meal planner behind a voice assistant. Goals: zero food waste and a short shopping list.
Rules:
- Use pantry items that expire soonest on the earliest days.
- Reuse the same bought ingredients across several days so the shopping list stays short.
- Vary cuisines and main ingredients from day to day.
- Every day must be a complete main dish with a protein or hearty base, never just a side (no plain garlic bread, salad or toast on its own).
- Assume salt, pepper, cooking oil and water are always available.
- At most 3 missing ingredients per day.
- NEVER use an ingredient the household is allergic to. Avoid their dislikes. Learn from past feedback.
Respond with ONLY a JSON array, one object per day in the given order, matching:
[{"day": string, "recipe": string, "minutes": number, "uses": string[], "missing": string[]}]`;

export async function generateMealPlan(opts: {
  pantry: PantryItem[];
  profile: HouseholdProfile;
  feedback: Feedback[];
  days: string[];
  meal: string;
  maxMinutes?: number;
}): Promise<{ days: PlanDay[]; skipped: Array<{ day: string; recipe: string; allergen: string }> }> {
  const prompt = [
    `Pantry (soonest expiry first):\n${opts.pantry.map((p) => `- ${describe(p)}`).join("\n")}`,
    householdContext(opts.profile, opts.feedback),
    `Plan ${opts.meal} for these days, in order: ${opts.days.join(", ")}.`,
    opts.maxMinutes ? `Each meal must take at most ${opts.maxMinutes} minutes.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const planned = extractJsonArray(await converse(PLAN_SYSTEM, [{ text: prompt }], 2000))
    .filter((d): d is Record<string, unknown> => isObject(d) && typeof d.recipe === "string")
    .map((d, i) => ({
      day: typeof d.day === "string" && d.day.trim() ? d.day.trim() : (opts.days[i] ?? `Day ${i + 1}`),
      recipe: String(d.recipe),
      minutes: Number(d.minutes) || 30,
      uses: strings(d.uses),
      missing: strings(d.missing).filter((m) => !STAPLES.has(m.trim().toLowerCase()) && !inPantry(opts.pantry, m)),
    }))
    .slice(0, opts.days.length);

  const days: PlanDay[] = [];
  const skipped: Array<{ day: string; recipe: string; allergen: string }> = [];
  for (const d of planned) {
    const allergen = findAllergen(opts.profile, [d.recipe, ...d.uses, ...d.missing]);
    if (allergen) skipped.push({ day: d.day, recipe: d.recipe, allergen });
    else days.push(d);
  }
  return { days, skipped };
}
