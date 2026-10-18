/**
 * Pantry Pal MCP App View.
 * Rendered inline by MCP Apps hosts (VS Code, Claude, ChatGPT, basic-host, ...).
 * One View serves several tools: it switches on `structuredContent.view` and can call other
 * Pantry Pal tools through the host (app.callServerTool), e.g. "Place order" -> confirm_grocery_order.
 */
import { App } from "@modelcontextprotocol/ext-apps";
import "./styles.css";

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}
interface Item { name: string; quantity: number; unit: string; expiresInDays: number | null; label: string }
interface Recipe { name: string; minutes: number; servings: number; uses: string[]; missing: string[]; steps: string[] }
interface PlanDay { day: string; recipe: string; minutes: number; uses: string[]; missing: string[] }
interface OrderLine { name: string; packs: number; unitPrice: number; lineTotal: number }
interface Order { id: string; store: string; lines: OrderLine[]; subtotal: number; deliveryFee: number; total: number; status: string }
type Message = { view: "message"; title: string; text: string; tone?: "ok" | "error"; action?: { label: string; tool: string } };
type View =
  | { view: "pantry"; title: string; items: Item[] }
  | { view: "recipes"; recipes: Recipe[]; household?: string }
  | { view: "plan"; meal: string; days: PlanDay[]; shopping: string[] }
  | { view: "order"; order: Order }
  | Message;

const root = document.getElementById("root")!;
const app = new App({ name: "Pantry Pal", version: "1.0.0" });
let busy = false;

// ---------- helpers (all text goes through textContent) ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const money = (n: number) => `$${n.toFixed(2)}`;
const textOf = (r: ToolResult) => (r.content ?? []).map((c) => c.text ?? "").join("\n").trim();
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function setBusy(v: boolean) {
  busy = v;
  root.classList.toggle("busy", v);
}

function toast(text: string, isError = false) {
  const t = el("div", `toast${isError ? " error" : ""}`, text);
  root.prepend(t);
  setTimeout(() => t.remove(), 3500);
}

function button(label: string, cls: string, onClick: () => Promise<void> | void) {
  const b = el("button", `btn ${cls}`, label);
  b.onclick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onClick();
    } catch (e) {
      toast((e as Error).message || String(e), true);
    } finally {
      setBusy(false);
    }
  };
  return b;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await app.callServerTool({ name, arguments: args })) as ToolResult;
}
const show = async (name: string, args: Record<string, unknown> = {}) => render(await call(name, args));

function header(title: string, subtitle?: string) {
  const h = el("div", "head");
  h.append(el("h2", "", title));
  if (subtitle) h.append(el("p", "sub", subtitle));
  return h;
}

function tags(list: string[], cls: string) {
  const box = el("div", "tags");
  for (const t of list) box.append(el("span", `tag ${cls}`, t));
  return box;
}

function badge(days: number | null) {
  if (days === null) return el("span", "badge", "shelf-stable");
  const cls = days <= 1 ? "bad" : days <= 3 ? "warn" : "ok";
  const text = days < 0 ? `expired ${-days}d ago` : days === 0 ? "expires today" : `${days} day${days === 1 ? "" : "s"} left`;
  return el("span", `badge ${cls}`, text);
}

// ---------- views ----------

function pantryView(d: Extract<View, { view: "pantry" }>) {
  const wrap = el("section");
  wrap.append(header(d.title, `${d.items.length} item${d.items.length === 1 ? "" : "s"}, soonest expiry first`));
  if (!d.items.length) wrap.append(el("p", "empty", "Nothing here yet."));
  const ul = el("ul", "rows");
  for (const it of d.items) {
    const li = el("li");
    const name = it.unit === "item" ? `${it.quantity} ${it.name}` : `${it.quantity} ${it.unit} ${it.name}`;
    li.append(
      el("div", "grow", name),
      badge(it.expiresInDays),
      button("Used it", "ghost small", async () => {
        await call("use_pantry_item", { name: it.name });
        await show("list_pantry");
      }),
    );
    ul.append(li);
  }
  if (d.items.length) wrap.append(ul);
  const actions = el("div", "actions");
  actions.append(
    button("What can I cook?", "primary", () => show("suggest_recipes")),
    button("Plan the week", "ghost", () => show("plan_meals")),
    button("Refresh", "ghost", () => show("list_pantry")),
  );
  wrap.append(actions);
  return wrap;
}

function recipesView(d: Extract<View, { view: "recipes" }>) {
  const wrap = el("section");
  wrap.append(header("Recipes from your pantry", d.household ? `Household: ${d.household}` : "Soonest-expiring food first"));
  const grid = el("div", "grid");
  for (const r of d.recipes) {
    const card = el("article", "card");
    card.append(el("h3", "", r.name), el("p", "meta", `${r.minutes} min, serves ${r.servings}`));
    if (r.uses.length) card.append(tags(r.uses, "use"));
    if (r.missing.length) card.append(tags(r.missing.map((m) => `buy ${m}`), "buy"));
    if (r.steps.length) {
      const det = el("details");
      const ol = el("ol");
      for (const s of r.steps) ol.append(el("li", "", s));
      det.append(el("summary", "", "Steps"), ol);
      card.append(det);
    }
    const act = el("div", "actions");
    if (r.missing.length) {
      act.append(
        button("Add missing to list", "primary small", async () => {
          const res = await call("add_missing_ingredients", { recipe_name: r.name });
          toast(textOf(res), Boolean(res.isError));
        }),
      );
    }
    act.append(
      button("Loved it", "ghost small", async () => toast(textOf(await call("rate_recipe", { recipe_name: r.name, rating: "loved" })))),
      button("Not for us", "ghost small", async () => toast(textOf(await call("rate_recipe", { recipe_name: r.name, rating: "disliked" })))),
    );
    card.append(act);
    grid.append(card);
  }
  wrap.append(grid);
  const actions = el("div", "actions");
  actions.append(button("Order what's missing", "primary", () => show("prepare_grocery_order")), button("Back to pantry", "ghost", () => show("list_pantry")));
  wrap.append(actions);
  return wrap;
}

function planView(d: Extract<View, { view: "plan" }>) {
  const wrap = el("section");
  wrap.append(header(`${capitalize(d.meal)} plan`, `${d.days.length} day${d.days.length === 1 ? "" : "s"}, expiring food first`));
  const ul = el("ul", "rows");
  for (const day of d.days) {
    const li = el("li");
    const left = el("div", "grow");
    left.append(el("div", "meta", day.day), el("div", "", `${day.recipe}, ${day.minutes} min`));
    if (day.missing.length) left.append(tags(day.missing.map((m) => `buy ${m}`), "buy"));
    li.append(left);
    ul.append(li);
  }
  wrap.append(ul);
  if (d.shopping.length) wrap.append(el("p", "meta", `Shopping list: ${d.shopping.join(", ")}`));
  const actions = el("div", "actions");
  if (d.shopping.length) actions.append(button("Order ingredients", "primary", () => show("prepare_grocery_order")));
  actions.append(button("Back to pantry", "ghost", () => show("list_pantry")));
  wrap.append(actions);
  return wrap;
}

function orderView(d: Extract<View, { view: "order" }>) {
  const o = d.order;
  const wrap = el("section");
  wrap.append(header(`Order ${o.id}`, `${o.store}. Nothing is charged until you confirm.`));
  const card = el("div", "card");
  for (const l of o.lines) {
    const line = el("div", "line");
    line.append(el("span", "", `${l.packs} x ${l.name}`), el("span", "", money(l.lineTotal)));
    card.append(line);
  }
  const fee = el("div", "line");
  fee.append(el("span", "", "Delivery"), el("span", "", money(o.deliveryFee)));
  const total = el("div", "line total");
  total.append(el("span", "", "Total"), el("span", "", money(o.total)));
  card.append(fee, total);
  wrap.append(card);
  const actions = el("div", "actions");
  if (o.status === "pending") {
    actions.append(
      button("Place order", "primary", () => show("confirm_grocery_order", { order_id: o.id })),
      button("Not now", "ghost", () => show("list_pantry")),
    );
  } else {
    actions.append(button("Back to pantry", "ghost", () => show("list_pantry")));
  }
  wrap.append(actions);
  return wrap;
}

function messageView(d: Message) {
  const wrap = el("section");
  const card = el("div", `card ${d.tone ?? ""}`);
  card.append(el("h3", "", d.title), el("p", "", d.text));
  wrap.append(card);
  const actions = el("div", "actions");
  if (d.action) actions.append(button(d.action.label, "primary", () => show(d.action!.tool)));
  actions.append(button("Show pantry", "ghost", () => show("list_pantry")));
  wrap.append(actions);
  return wrap;
}

function render(result: ToolResult) {
  const data = result.structuredContent as View | undefined;
  root.replaceChildren();
  if (!data || typeof data !== "object" || !("view" in data)) {
    root.append(
      messageView({
        view: "message",
        title: result.isError ? "Something went wrong" : "Pantry Pal",
        text: textOf(result) || "Done.",
        tone: result.isError ? "error" : undefined,
      }),
    );
    return;
  }
  switch (data.view) {
    case "pantry": root.append(pantryView(data)); break;
    case "recipes": root.append(recipesView(data)); break;
    case "plan": root.append(planView(data)); break;
    case "order": root.append(orderView(data)); break;
    default: root.append(messageView(data));
  }
}

// Register handlers before connect() so the initial tool result is not missed.
app.ontoolresult = (result) => render(result as ToolResult);
app.connect();
