import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

// Point the store at a scratch file before any module reads DATA_FILE.
process.env.DATA_FILE = path.join(os.tmpdir(), `pantry-pal-test-${process.pid}-${Date.now()}.json`);
process.env.SCAN_DIR = path.join(os.tmpdir(), "pantry-pal-no-photos");

const store = await import("../src/store.js");
const { priceFor, packsFor, money } = await import("../src/catalog.js");
const { extractJsonArray, findAllergen, inPantry } = await import("../src/bedrock.js");
const { buildServer } = await import("../src/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

beforeEach(async () => {
  await store.resetStore();
});

// ---------- store ----------

test("pantry: merges the same item, keeps the earliest expiry, sorts by expiry", async () => {
  await store.addPantryItem({ name: "Eggs", quantity: 6, expiresInDays: 10 });
  await store.addPantryItem({ name: "eggs", quantity: 6, expiresInDays: 5 });
  await store.addPantryItem({ name: "rice", quantity: 1, unit: "kg" });
  await store.addPantryItem({ name: "spinach", quantity: 1, unit: "bag", expiresInDays: 1 });

  const items = await store.listPantry();
  assert.deepEqual(items.map((i) => i.name), ["spinach", "Eggs", "rice"]);
  assert.equal(items[1].quantity, 12);
  assert.equal(store.daysLeft(items[1]), 5);
  assert.equal(store.describe(items[0]), "1 bag of spinach (expires in 1 day)");
  assert.deepEqual((await store.listPantry(3)).map((i) => i.name), ["spinach"]);
});

test("pantry: using an item decrements, then removes it", async () => {
  await store.addPantryItem({ name: "milk", quantity: 2, unit: "litre" });
  assert.equal((await store.usePantryItem("Milk", 1)).remaining?.quantity, 1);
  const all = await store.usePantryItem("milk");
  assert.equal(all.found, true);
  assert.equal(all.remaining, undefined);
  assert.equal((await store.listPantry()).length, 0);
  assert.equal((await store.usePantryItem("caviar")).found, false);
});

test("shopping: de-duplicates and completeShopping stocks the pantry", async () => {
  const added = await store.addShoppingItems([{ name: "ginger" }, { name: "Ginger" }, { name: "basil", quantity: 2 }]);
  assert.deepEqual(added.map((a) => a.name), ["ginger", "basil"]);
  assert.deepEqual((await store.completeShopping(["basil"])).map((b) => b.name), ["basil"]);
  assert.deepEqual((await store.getShoppingList()).map((s) => s.name), ["ginger"]);
  assert.equal((await store.listPantry())[0].quantity, 2);
});

test("household: merges allergy and dislike lists case-insensitively, caps feedback at 50", async () => {
  await store.updateProfile({ people: 4, addAllergies: ["Eggs"], addDislikes: ["mushrooms", "olives"] });
  const p = await store.updateProfile({ addAllergies: ["eggs", "peanuts"], removeDislikes: ["Olives"] });
  assert.equal(p.people, 4);
  assert.deepEqual(p.allergies, ["Eggs", "peanuts"]);
  assert.deepEqual(p.dislikes, ["mushrooms"]);
  assert.match(store.describeProfile(p), /4 people; allergies: Eggs, peanuts; dislikes: mushrooms/);

  for (let i = 0; i < 55; i++) await store.addFeedback(`r${i}`, "liked");
  assert.equal((await store.recentFeedback(100)).length, 50);
  assert.equal((await store.recentFeedback(1))[0].recipe, "r54");
});

test("orders: new quote replaces pending; placing clears the list; delivery stocks the pantry", async () => {
  await store.addShoppingItems([{ name: "ginger" }, { name: "soy sauce" }]);
  const line = { name: "ginger", packs: 1, unitPrice: 1, lineTotal: 1 };
  const q1 = await store.createOrder({ store: "Demo", lines: [line], subtotal: 1, deliveryFee: 1, total: 2 });
  const q2 = await store.createOrder({
    store: "Demo",
    lines: [line, { name: "soy sauce", packs: 2, unitPrice: 1, lineTotal: 2 }],
    subtotal: 3,
    deliveryFee: 1,
    total: 4,
  });
  assert.equal((await store.getPendingOrder())?.id, q2.id);
  if (q1.id !== q2.id) assert.match((await store.placeOrder(q1.id)).error ?? "", /can't find/);

  const placed = await store.placeOrder(q2.id);
  assert.equal(placed.order?.status, "placed");
  assert.equal((await store.getShoppingList()).length, 0);
  assert.match((await store.placeOrder(q2.id)).error ?? "", /already placed/);

  assert.equal((await store.receiveOrder()).order?.id, q2.id);
  assert.equal((await store.listPantry()).find((p) => p.name === "soy sauce")?.quantity, 2);
  assert.match((await store.receiveOrder()).error ?? "", /no order/);
});

test("meal plan persists", async () => {
  assert.equal(await store.getMealPlan(), undefined);
  await store.saveMealPlan({
    createdAt: "2026-10-17T00:00:00Z",
    meal: "dinner",
    days: [{ day: "Monday", recipe: "Dal", minutes: 30, uses: ["lentils"], missing: [] }],
  });
  assert.equal((await store.getMealPlan())?.days[0].recipe, "Dal");
});

// ---------- catalog ----------

test("catalog: fuzzy prices, pack counting and money formatting", () => {
  assert.equal(priceFor("fresh ginger"), 1.29);
  assert.equal(priceFor("soy sauce"), 3.49);
  assert.equal(priceFor("Tomatoes"), 0.79);
  assert.equal(priceFor("dragon fruit"), 2.99);
  assert.equal(packsFor(500, "g"), 1);
  assert.equal(packsFor(6, undefined), 6);
  assert.equal(packsFor(50, "item"), 12);
  assert.equal(packsFor(undefined, undefined), 1);
  assert.equal(money(3.5), "$3.50");
});

// ---------- model output helpers ----------

test("extractJsonArray: code fences, surrounding prose and truncated output", () => {
  assert.deepEqual(extractJsonArray('Sure! ```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJsonArray('[{"name":"eggs","quantity":6},{"name":"milk","qua'), [{ name: "eggs", quantity: 6 }]);
  assert.throws(() => extractJsonArray("no json here"), /did not return a JSON array/);
});

test("findAllergen: singular and plural, word boundaries", () => {
  const profile = { people: 2, allergies: ["eggs", "peanuts"], dislikes: [] };
  assert.equal(findAllergen(profile, ["Beat 1 egg"]), "eggs");
  assert.equal(findAllergen(profile, ["peanut butter"]), "peanuts");
  assert.equal(findAllergen(profile, ["eggplant parmesan"]), undefined);
  assert.equal(findAllergen(profile, ["tofu"]), undefined);
});

test("inPantry: ignores filler words, matches single-word ingredients inside pantry names", () => {
  const pantry = [
    { name: "cheddar", quantity: 200, unit: "g", addedAt: "" },
    { name: "chicken thighs", quantity: 500, unit: "g", addedAt: "" },
    { name: "rice", quantity: 1, unit: "kg", addedAt: "" },
  ];
  assert.ok(inPantry(pantry, "cheddar cheese"));
  assert.ok(inPantry(pantry, "chicken"));
  assert.ok(!inPantry(pantry, "soy sauce"));
  assert.ok(!inPantry(pantry, "rice vinegar"));
});

// ---------- MCP server (no Bedrock needed) ----------

test("MCP server: 17 tools, UI metadata, pantry round-trip, consent guard and photo sandbox", async () => {
  const server = buildServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  assert.equal(tools.length, 17);
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const n of ["scan_groceries", "suggest_recipes", "plan_meals", "prepare_grocery_order", "confirm_grocery_order", "rate_recipe"]) {
    assert.ok(byName.has(n), `missing tool ${n}`);
  }
  assert.equal(byName.get("list_pantry")?.annotations?.readOnlyHint, true);
  assert.deepEqual((byName.get("list_pantry")?._meta as { ui?: unknown } | undefined)?.ui, { resourceUri: "ui://pantry-pal/app.html" });

  const { resources } = await client.listResources();
  assert.equal(resources.find((r) => r.uri === "ui://pantry-pal/app.html")?.mimeType, "text/html;profile=mcp-app");

  await client.callTool({ name: "add_pantry_item", arguments: { name: "milk", quantity: 1, unit: "litre", expires_in_days: 4 } });
  const list = (await client.callTool({ name: "list_pantry", arguments: {} })) as {
    content: Array<{ text: string }>;
    structuredContent?: { view: string; items: Array<{ name: string; expiresInDays: number | null }> };
  };
  assert.match(list.content[0].text, /1 litre of milk \(expires in 4 days\)/);
  assert.equal(list.structuredContent?.view, "pantry");
  assert.equal(list.structuredContent?.items[0].expiresInDays, 4);

  const noOrder = (await client.callTool({ name: "confirm_grocery_order", arguments: {} })) as { isError?: boolean };
  assert.equal(noOrder.isError, true);

  const escape = (await client.callTool({ name: "scan_groceries", arguments: { image_path: "../../etc/passwd" } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(escape.isError, true);
  assert.match(escape.content[0].text, /inside the/);

  await client.close();
  await server.close();
});
