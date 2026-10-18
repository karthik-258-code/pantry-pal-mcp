import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateMealPlan, generateRecipes, MODEL_ID, scanGroceries, type ImageFormat, type Recipe } from "./bedrock.js";
import { DELIVERY_FEE, money, packsFor, priceFor, STORE_NAME } from "./catalog.js";
import * as store from "./store.js";
import { currentHousehold } from "./context.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** e.g. ["Today (Saturday)", "Sunday", "Monday"] */
function upcomingDays(n: number): string[] {
  const today = new Date().getDay();
  return Array.from({ length: n }, (_, i) => (i === 0 ? `Today (${WEEKDAYS[today]})` : WEEKDAYS[(today + i) % 7]));
}

const SCAN_DIR = path.resolve(process.env.SCAN_DIR ?? "photos");

// MCP Apps: tools point at a ui:// resource that hosts render in a sandboxed iframe.
const APP_URI = "ui://pantry-pal/app.html";
const APP_MIME = "text/html;profile=mcp-app";
const APP_HTML = path.resolve(process.env.APP_HTML ?? "apps/dist/mcp-app.html");
const UI_META = { ui: { resourceUri: APP_URI } };

async function appHtml(): Promise<string> {
  try {
    return await fs.readFile(APP_HTML, "utf8");
  } catch {
    return `<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:12px">The Pantry Pal UI isn't built yet. Run <code>npm run build:apps</code> and call the tool again.</p>`;
  }
}

/** Shape shared with the View (apps/src/mcp-app.ts). */
function pantryItem(i: store.PantryItem) {
  return { name: i.name, quantity: i.quantity, unit: i.unit, expiresInDays: store.daysLeft(i) ?? null, label: store.describe(i) };
}
// Bedrock Converse image size limit.
const MAX_IMAGE_BYTES = 3_750_000;

const INSTRUCTIONS = `Pantry Pal remembers the household's pantry, shopping list, allergies, dislikes and recipe feedback,
and suggests recipes that use food before it expires. Keep spoken replies to 1-2 short sentences.
- "What can I cook?" -> suggest_recipes (it already applies the household profile and past feedback).
- A photo of a fridge, shelf or receipt -> scan_groceries.
- "We loved/hated that" -> rate_recipe.
- Allergies, diet, family size, dislikes -> update_household_profile.
- Ingredients for a suggested recipe -> add_missing_ingredients. Bought groceries -> mark_shopping_done.
- "Plan the week" -> plan_meals (it also adds missing ingredients to the shopping list).
- "Order it" -> prepare_grocery_order, read out the total, and ONLY call confirm_grocery_order after the user explicitly says yes.
- "Groceries arrived" -> receive_grocery_order.`;

function detectFormat(b: Uint8Array): ImageFormat | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  return undefined;
}

async function loadImage(imagePath?: string, imageBase64?: string): Promise<Uint8Array> {
  if (imageBase64) {
    return new Uint8Array(Buffer.from(imageBase64.replace(/^data:[^;]+;base64,/, ""), "base64"));
  }
  if (imagePath) {
    // Only read from the photos folder so a tool call can never read arbitrary files.
    const full = path.resolve(SCAN_DIR, imagePath);
    if (!full.startsWith(SCAN_DIR + path.sep)) throw new Error(`Photos must be inside the ${SCAN_DIR} folder`);
    return new Uint8Array(await fs.readFile(full));
  }
  throw new Error("Provide image_path or image_base64");
}

// Kept across stateless requests (per household) so "add what I'm missing for the frittata" works.
const lastRecipesByHousehold = new Map<string, Recipe[]>();
const lastRecipes = () => lastRecipesByHousehold.get(currentHousehold()) ?? [];
const rememberRecipes = (recipes: Recipe[]) => lastRecipesByHousehold.set(currentHousehold(), recipes);

function reply(text: string, isError = false, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function findRecipe(query: string): Recipe | undefined {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "one"].includes(w));
  let best: Recipe | undefined;
  let bestScore = 0;
  for (const r of lastRecipes()) {
    const name = r.name.toLowerCase();
    const score = words.filter((w) => name.includes(w)).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "pantry-pal", version: "1.3.0" }, { instructions: INSTRUCTIONS });

  // ---------- MCP App (interactive UI) ----------

  server.registerResource(
    "pantry-pal-app",
    APP_URI,
    {
      title: "Pantry Pal interactive view",
      description: "Interactive pantry, recipes, meal plan and order confirmation, rendered inline by MCP Apps hosts.",
      mimeType: APP_MIME,
    },
    async () => ({ contents: [{ uri: APP_URI, mimeType: APP_MIME, text: await appHtml() }] }),
  );

  server.registerTool(
    "add_pantry_item",
    {
      title: "Add pantry item",
      description: "Add food to the pantry, e.g. 'I bought 6 eggs that expire in 10 days'.",
      inputSchema: {
        name: z.string().min(1).describe("Food name, e.g. 'eggs'"),
        quantity: z.number().positive().default(1).describe("Amount"),
        unit: z.string().optional().describe("Unit such as 'g', 'bag', 'bottle'. Omit for countable items."),
        expires_in_days: z.number().int().min(0).optional().describe("Days until it expires"),
      },
    },
    async ({ name, quantity, unit, expires_in_days }) => {
      const item = await store.addPantryItem({ name, quantity, unit, expiresInDays: expires_in_days });
      return reply(`Added. You now have ${store.describe(item)}.`);
    },
  );

  server.registerTool(
    "scan_groceries",
    {
      title: "Scan groceries from a photo",
      description:
        "Use Amazon Bedrock vision to identify food in a photo of a fridge, pantry shelf or grocery receipt, estimate expiry dates and add the items to the pantry. Pass image_path (a file name inside the server's photos folder) or image_base64.",
      inputSchema: {
        image_path: z.string().optional().describe("File name inside the photos folder, e.g. 'fridge.jpg'"),
        image_base64: z.string().optional().describe("Base64-encoded JPEG/PNG/WebP/GIF, optionally as a data: URL"),
        source: z.enum(["fridge", "pantry", "receipt"]).default("fridge").describe("What the photo shows"),
        add_to_pantry: z.boolean().default(true).describe("Add the detected items to the pantry"),
      },
      annotations: { openWorldHint: true },
      _meta: UI_META,
    },
    async ({ image_path, image_base64, source, add_to_pantry }) => {
      try {
        const bytes = await loadImage(image_path, image_base64);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return reply("That photo is larger than 3.75 MB. Please use a smaller photo or a screenshot.", true);
        }
        const format = detectFormat(bytes);
        if (!format) return reply("Unsupported image. Use JPEG, PNG, WebP or GIF (iPhone HEIC photos are not supported).", true);

        const items = await scanGroceries(bytes, format, source);
        if (!items.length) return reply("I couldn't spot any food in that photo.");

        const lines: string[] = [];
        const shown: Array<ReturnType<typeof pantryItem>> = [];
        for (const i of items) {
          if (add_to_pantry) {
            const saved = await store.addPantryItem(i);
            shown.push(pantryItem(saved));
            lines.push(`- ${store.describe(saved)}`);
          } else {
            const unit = i.unit ? ` ${i.unit} of` : "";
            const exp = i.expiresInDays !== undefined ? ` (about ${i.expiresInDays} days)` : "";
            const label = `${i.quantity}${unit} ${i.name}${exp}`;
            shown.push({ name: i.name, quantity: i.quantity, unit: i.unit ?? "item", expiresInDays: i.expiresInDays ?? null, label });
            lines.push(`- ${label}`);
          }
        }
        return reply(
          `I ${add_to_pantry ? "added" : "found"} ${items.length} item${items.length === 1 ? "" : "s"} from your ${source} photo:\n${lines.join("\n")}\n\n(Recognised by Amazon Bedrock, model ${MODEL_ID})`,
          false,
          { view: "pantry", title: `Found in your ${source} photo`, items: shown },
        );
      } catch (err) {
        return reply(`Scanning failed: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "use_pantry_item",
    {
      title: "Use or remove pantry item",
      description: "Record that food was used, eaten or thrown away. Omit quantity to remove it entirely.",
      inputSchema: {
        name: z.string().min(1).describe("Food name"),
        quantity: z.number().positive().optional().describe("Amount used"),
      },
    },
    async ({ name, quantity }) => {
      const res = await store.usePantryItem(name, quantity);
      if (!res.found) return reply(`I couldn't find ${name} in your pantry.`, true);
      return reply(res.remaining ? `Done. ${store.describe(res.remaining)} left.` : `Done. ${name} is gone from your pantry.`);
    },
  );

  server.registerTool(
    "list_pantry",
    {
      title: "List pantry",
      description: "List what's in the pantry, soonest expiry first. Use expiring_within_days for 'what's about to go bad?'.",
      inputSchema: {
        expiring_within_days: z.number().int().min(0).optional().describe("Only items expiring within this many days"),
      },
      annotations: { readOnlyHint: true },
      _meta: UI_META,
    },
    async ({ expiring_within_days }) => {
      const items = await store.listPantry(expiring_within_days);
      const title = expiring_within_days !== undefined ? `Expiring within ${expiring_within_days} days` : "Pantry";
      const view = { view: "pantry", title, items: items.map(pantryItem) };
      if (!items.length) {
        return reply(expiring_within_days !== undefined ? "Nothing is about to expire." : "Your pantry is empty.", false, view);
      }
      return reply(`You have ${items.length} item${items.length === 1 ? "" : "s"}:\n${items.map((i) => `- ${store.describe(i)}`).join("\n")}`, false, view);
    },
  );

  server.registerTool(
    "suggest_recipes",
    {
      title: "Suggest recipes",
      description:
        "Use Amazon Bedrock to suggest recipes from the pantry, prioritising food that expires soonest and applying the household's allergies, dislikes and past feedback. Use for 'what can I cook?'.",
      inputSchema: {
        meal: z.string().optional().describe("e.g. 'breakfast', 'quick dinner'"),
        servings: z.number().int().min(1).max(12).optional().describe("Defaults to the household size"),
        dietary: z.string().optional().describe("Extra requirement for this meal only, e.g. 'vegetarian'"),
        max_minutes: z.number().int().positive().optional().describe("Maximum cooking time"),
        count: z.number().int().min(1).max(3).default(2).describe("How many recipes"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: UI_META,
    },
    async ({ meal, servings, dietary, max_minutes, count }) => {
      const pantry = await store.listPantry();
      if (!pantry.length) return reply("Your pantry is empty. Add a few items or scan a photo of your fridge first.");
      try {
        const [profile, feedback] = await Promise.all([store.getProfile(), store.recentFeedback()]);
        const recipes = await generateRecipes({
          pantry,
          profile,
          feedback,
          servings: servings ?? profile.people,
          count,
          meal,
          dietary,
          maxMinutes: max_minutes,
        });
        if (!recipes.length) return reply("I couldn't come up with a safe recipe. Try relaxing the constraints.", true);
        rememberRecipes(recipes);
        const spoken = recipes.map((r) => `${r.name} in ${r.minutes} minutes`).join(", or ");
        const details = recipes
          .map((r, i) =>
            [
              `${i + 1}. ${r.name} (${r.minutes} min, serves ${r.servings})`,
              `   Uses: ${r.uses.join(", ") || "n/a"}`,
              `   Missing: ${r.missing.join(", ") || "nothing"}`,
              ...r.steps.map((s, j) => `   ${j + 1}) ${s}`),
            ].join("\n"),
          )
          .join("\n\n");
        return reply(
          `You could make ${spoken}.\n\n${details}\n\nHousehold: ${store.describeProfile(profile)}.\n(Generated by Amazon Bedrock, model ${MODEL_ID})`,
          false,
          { view: "recipes", recipes, household: store.describeProfile(profile) },
        );
      } catch (err) {
        return reply(
          `Recipe generation failed: ${(err as Error).message}. Check AWS credentials and Bedrock model access for ${MODEL_ID}.`,
          true,
        );
      }
    },
  );

  server.registerTool(
    "add_missing_ingredients",
    {
      title: "Add missing ingredients",
      description: "Add the missing ingredients of a recipe from the last suggest_recipes call to the shopping list.",
      inputSchema: {
        recipe_name: z.string().min(1).describe("Recipe name or part of it, e.g. 'frittata'"),
      },
    },
    async ({ recipe_name }) => {
      if (!lastRecipes().length) return reply("Ask me for recipe ideas first.", true);
      const recipe = findRecipe(recipe_name);
      if (!recipe) {
        return reply(`I don't see "${recipe_name}" in the last suggestions: ${lastRecipes().map((r) => r.name).join(", ")}.`, true);
      }
      if (!recipe.missing.length) return reply(`You already have everything for ${recipe.name}.`);
      const added = await store.addShoppingItems(recipe.missing.map((name) => ({ name, reason: recipe.name })));
      return reply(
        added.length
          ? `Added ${added.map((i) => i.name).join(", ")} to your shopping list for ${recipe.name}.`
          : `Everything for ${recipe.name} is already on your shopping list.`,
      );
    },
  );

  server.registerTool(
    "rate_recipe",
    {
      title: "Rate a recipe",
      description:
        "Remember how the household felt about a recipe, e.g. 'the kids loved the frittata' or 'too spicy'. Future suggestions learn from this.",
      inputSchema: {
        recipe_name: z.string().min(1).describe("Recipe name, or part of it"),
        rating: z.enum(["loved", "liked", "disliked"]),
        note: z.string().optional().describe("Why, e.g. 'too spicy', 'kids asked for seconds'"),
      },
    },
    async ({ recipe_name, rating, note }) => {
      const name = findRecipe(recipe_name)?.name ?? recipe_name;
      await store.addFeedback(name, rating, note);
      return reply(`Got it, I'll remember you ${rating} ${name}${note ? ` (${note})` : ""}.`);
    },
  );

  server.registerTool(
    "get_household_profile",
    {
      title: "Get household profile",
      description: "Read the remembered household size, diet, allergies, dislikes and recent recipe feedback.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [profile, feedback] = await Promise.all([store.getProfile(), store.recentFeedback(5)]);
      const fb = feedback.length
        ? `\nRecent feedback:\n${feedback.map((f) => `- ${f.rating} ${f.recipe}${f.note ? ` (${f.note})` : ""}`).join("\n")}`
        : "";
      return reply(`Household: ${store.describeProfile(profile)}.${fb}`);
    },
  );

  server.registerTool(
    "update_household_profile",
    {
      title: "Update household profile",
      description:
        "Remember household facts across sessions: number of people, diet, allergies and dislikes. Use add_/remove_ lists for changes, e.g. 'my son is allergic to peanuts'.",
      inputSchema: {
        people: z.number().int().min(1).max(20).optional(),
        diet: z.string().optional().describe("e.g. 'vegetarian', 'halal'. Empty string clears it."),
        add_allergies: z.array(z.string().min(1)).optional(),
        remove_allergies: z.array(z.string().min(1)).optional(),
        add_dislikes: z.array(z.string().min(1)).optional(),
        remove_dislikes: z.array(z.string().min(1)).optional(),
        notes: z.string().optional().describe("Free-form, e.g. 'kids prefer mild food'"),
      },
    },
    async (u) => {
      const profile = await store.updateProfile({
        people: u.people,
        diet: u.diet,
        notes: u.notes,
        addAllergies: u.add_allergies,
        removeAllergies: u.remove_allergies,
        addDislikes: u.add_dislikes,
        removeDislikes: u.remove_dislikes,
      });
      return reply(`Saved. Household: ${store.describeProfile(profile)}.`);
    },
  );

  // ---------- Meal planning and checkout ----------

  server.registerTool(
    "plan_meals",
    {
      title: "Plan meals for several days",
      description:
        "Use Amazon Bedrock to plan meals for the next few days: expiring food first, household allergies, dislikes and feedback respected, ingredients shared across days to keep shopping short. Adds missing ingredients to the shopping list.",
      inputSchema: {
        days: z.number().int().min(1).max(7).default(5),
        meal: z.string().default("dinner").describe("e.g. 'dinner', 'lunch'"),
        max_minutes: z.number().int().positive().optional(),
        add_to_shopping_list: z.boolean().default(true),
      },
      annotations: { openWorldHint: true },
      _meta: UI_META,
    },
    async ({ days, meal, max_minutes, add_to_shopping_list }) => {
      const pantry = await store.listPantry();
      if (!pantry.length) return reply("Your pantry is empty. Scan your fridge or add a few items first.");
      try {
        const [profile, feedback] = await Promise.all([store.getProfile(), store.recentFeedback()]);
        const { days: plan, skipped } = await generateMealPlan({
          pantry,
          profile,
          feedback,
          days: upcomingDays(days),
          meal,
          maxMinutes: max_minutes,
        });
        if (!plan.length) return reply("I couldn't build a safe plan. Try fewer days or relax the constraints.", true);
        await store.saveMealPlan({ createdAt: new Date().toISOString(), meal, days: plan });

        const toBuy = new Map<string, { name: string; reason: string }>();
        for (const d of plan) {
          for (const m of d.missing) {
            if (!toBuy.has(m.toLowerCase())) toBuy.set(m.toLowerCase(), { name: m, reason: `${d.day}: ${d.recipe}` });
          }
        }
        if (add_to_shopping_list) await store.addShoppingItems([...toBuy.values()]);

        const lines = plan.map(
          (d) => `- ${d.day}: ${d.recipe} (${d.minutes} min)${d.missing.length ? `, buy ${d.missing.join(", ")}` : ""}`,
        );
        const names = [...toBuy.values()].map((t) => t.name).join(", ");
        const shopNote = !toBuy.size
          ? "You already have everything."
          : add_to_shopping_list
            ? `I put ${toBuy.size} item${toBuy.size === 1 ? "" : "s"} on your shopping list: ${names}. Say "order it" to check out.`
            : `You'd need: ${names}.`;
        const skippedNote = skipped.length
          ? `\nI dropped ${skipped.map((s) => `${s.recipe} (contains ${s.allergen})`).join(", ")} for safety.`
          : "";
        return reply(
          `Here's your ${meal} plan for ${plan.length} day${plan.length === 1 ? "" : "s"}:\n${lines.join("\n")}\n\n${shopNote}${skippedNote}\n(Planned by Amazon Bedrock, model ${MODEL_ID})`,
          false,
          { view: "plan", meal, days: plan, shopping: [...toBuy.values()].map((t) => t.name) },
        );
      } catch (err) {
        return reply(`Meal planning failed: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "get_meal_plan",
    {
      title: "Get meal plan",
      description: "Read the saved meal plan, e.g. 'what's for dinner tomorrow?'.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      _meta: UI_META,
    },
    async () => {
      const plan = await store.getMealPlan();
      if (!plan) return reply("There's no meal plan yet. Ask me to plan the week.");
      const made = new Date(plan.createdAt).toDateString();
      return reply(
        `Your ${plan.meal} plan (made ${made}):\n${plan.days.map((d) => `- ${d.day}: ${d.recipe} (${d.minutes} min)`).join("\n")}`,
        false,
        { view: "plan", meal: plan.meal, days: plan.days, shopping: [] },
      );
    },
  );

  server.registerTool(
    "prepare_grocery_order",
    {
      title: "Prepare grocery order",
      description: `Price the shopping list (or the named items) at ${STORE_NAME} and create a quote. Nothing is charged. Read the total to the user and ask them to confirm.`,
      inputSchema: {
        items: z.array(z.string().min(1)).optional().describe("Only these shopping-list items. Omit for the whole list."),
      },
      _meta: UI_META,
    },
    async ({ items }) => {
      const list = await store.getShoppingList();
      const wanted = items?.length ? new Set(items.map((i) => i.trim().toLowerCase())) : undefined;
      const chosen = list.filter((s) => !wanted || wanted.has(s.name.toLowerCase()));
      if (!chosen.length) {
        return reply(list.length ? "None of those are on your shopping list." : "Your shopping list is empty. Plan some meals or add items first.");
      }
      const lines = chosen.map((s) => {
        const packs = packsFor(s.quantity, s.unit);
        const unitPrice = priceFor(s.name);
        return { name: s.name, packs, unitPrice, lineTotal: round2(packs * unitPrice) };
      });
      const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
      const order = await store.createOrder({
        store: STORE_NAME,
        lines,
        subtotal,
        deliveryFee: DELIVERY_FEE,
        total: round2(subtotal + DELIVERY_FEE),
      });
      const detail = lines.map((l) => `- ${l.packs} x ${l.name} @ ${money(l.unitPrice)} = ${money(l.lineTotal)}`).join("\n");
      return reply(
        `Your order ${order.id} from ${STORE_NAME} has ${lines.length} item${lines.length === 1 ? "" : "s"} and comes to ${money(order.total)}, including ${money(DELIVERY_FEE)} delivery. Should I place it?\n\n${detail}\nSubtotal: ${money(subtotal)}\n\nNothing has been charged. Only call confirm_grocery_order with order_id ${order.id} after the user says yes.`,
        false,
        { view: "order", order },
      );
    },
  );

  server.registerTool(
    "confirm_grocery_order",
    {
      title: "Confirm grocery order",
      description:
        "Place a prepared order. ONLY call this after the user explicitly confirms the total. Simulated checkout: no real payment is made.",
      inputSchema: {
        order_id: z.string().optional().describe("Order ID from prepare_grocery_order. Defaults to the pending quote."),
      },
      _meta: UI_META,
    },
    async ({ order_id }) => {
      const id = order_id ?? (await store.getPendingOrder())?.id;
      if (!id) return reply("There's no order waiting for confirmation. Ask me to prepare one first.", true);
      const { order, error } = await store.placeOrder(id);
      if (!order) return reply(error ?? "Couldn't place the order.", true);
      return reply(
        `Done! Order ${order.id} is placed for ${money(order.total)}. Delivery is expected tomorrow evening. Say "my groceries arrived" and I'll stock your pantry.\n(Simulated checkout, no real purchase was made.)`,
        false,
        {
          view: "message",
          title: "Order placed",
          text: `Order ${order.id} is placed for ${money(order.total)}. Delivery is expected tomorrow evening. Simulated checkout, no real purchase was made.`,
          tone: "ok",
          action: { label: "Groceries arrived", tool: "receive_grocery_order" },
        },
      );
    },
  );

  server.registerTool(
    "receive_grocery_order",
    {
      title: "Receive grocery order",
      description: "Mark a placed order as delivered and add its items to the pantry, e.g. 'my groceries arrived'.",
      inputSchema: {
        order_id: z.string().optional().describe("Defaults to the most recent placed order"),
      },
    },
    async ({ order_id }) => {
      const { order, error } = await store.receiveOrder(order_id);
      if (!order) return reply(error ?? "Couldn't find that order.", true);
      return reply(`Welcome home! I added ${order.lines.map((l) => l.name).join(", ")} to your pantry.`, false, {
        view: "message",
        title: "Delivered",
        text: `Added ${order.lines.map((l) => l.name).join(", ")} to your pantry.`,
        tone: "ok",
      });
    },
  );

  server.registerTool(
    "add_to_shopping_list",
    {
      title: "Add to shopping list",
      description: "Add one or more items to the shopping list.",
      inputSchema: {
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              quantity: z.number().positive().optional(),
              unit: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ items }) => {
      const added = await store.addShoppingItems(items);
      return reply(added.length ? `Added ${added.map((i) => i.name).join(", ")}.` : "Those are already on your list.");
    },
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get shopping list",
      description: "Read the shopping list.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list = await store.getShoppingList();
      if (!list.length) return reply("Your shopping list is empty.");
      const lines = list.map((i) => {
        const amount = i.quantity ? `${i.quantity}${i.unit ? ` ${i.unit}` : ""} ` : "";
        return `- ${amount}${i.name}${i.reason ? ` (for ${i.reason})` : ""}`;
      });
      return reply(`${list.length} item${list.length === 1 ? "" : "s"} on your list:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "mark_shopping_done",
    {
      title: "Mark shopping done",
      description: "Move bought items from the shopping list into the pantry. Omit items to move everything.",
      inputSchema: {
        items: z.array(z.string().min(1)).optional().describe("Names of the items bought"),
      },
    },
    async ({ items }) => {
      const bought = await store.completeShopping(items);
      return reply(
        bought.length
          ? `Nice. I moved ${bought.map((b) => b.name).join(", ")} into your pantry.`
          : "I didn't find those on your shopping list.",
      );
    },
  );

  return server;
}
