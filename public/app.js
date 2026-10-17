// Pantry Pal simulated Alexa+ front end. All model/tool text is rendered with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const state = { muted: false, busy: false, audio: null, rec: null };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const setRing = (mode) => ($("ring").className = `ring ${mode || ""}`);

// ---------- Clock ----------
const tick = () => ($("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
tick();
setInterval(tick, 15000);

// ---------- Suggestion chips ----------
const STARTERS = [
  "We're a family of 4 and my son is allergic to eggs",
  "What's about to expire?",
  "What can I cook tonight?",
  "Plan dinners for the next 5 days",
  "What do you remember about us?",
];
const FOLLOW_UPS = {
  suggest_recipes: ["Add what I'm missing for the first one", "We loved the first one", "Plan dinners for the next 5 days"],
  plan_meals: ["Order it", "What's for dinner tomorrow?"],
  prepare_grocery_order: ["Yes, place the order", "Not now"],
  confirm_grocery_order: ["My groceries arrived"],
  receive_grocery_order: ["What can I cook tonight?", "What's for dinner tomorrow?"],
  scan_groceries: ["What's about to expire?", "What can I cook tonight?"],
  add_missing_ingredients: ["Order it", "What's on my shopping list?"],
};
function showChips(list) {
  const box = $("chips");
  box.replaceChildren();
  for (const t of list) {
    const b = el("button", "chip", t);
    b.onclick = () => send(t);
    box.append(b);
  }
}
showChips(STARTERS);

// ---------- API ----------
async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

async function send(text) {
  text = (text || "").trim();
  if (!text || state.busy) return;
  state.busy = true;
  stopSpeaking();
  $("userSaid").textContent = `“${text}”`;
  $("textInput").value = "";
  $("alexaSays").textContent = "…";
  setRing("thinking");
  try {
    render(await api("/api/chat", { text }));
  } catch (e) {
    $("alexaSays").textContent = `Sorry, something went wrong: ${e.message}`;
    setRing("");
  } finally {
    state.busy = false;
  }
}

function render({ say, calls }) {
  $("alexaSays").textContent = say || "Done.";
  const cards = $("cards");
  cards.replaceChildren();
  for (const c of calls) {
    logCall(c);
    const card = cardFor(c);
    if (card) cards.append(card);
  }
  const last = [...calls].reverse().find((c) => FOLLOW_UPS[c.name]);
  showChips(last ? FOLLOW_UPS[last.name] : STARTERS);
  speak(say);
}

// ---------- MCP activity log ----------
function logCall(c) {
  const li = el("li", c.isError ? "err" : "");
  li.append(el("span", "name", c.name), el("span", "ms", `${c.ms} ms`));
  const args = { ...c.input };
  if (typeof args.image_base64 === "string") args.image_base64 = `<${Math.round(args.image_base64.length / 1024)} KB image>`;
  li.append(el("div", "", JSON.stringify(args)));
  const d = el("details");
  d.append(el("summary", "", c.isError ? "error" : "result"), el("pre", "", c.result));
  li.append(d);
  $("mcpLog").prepend(li);
}

// ---------- Cards ----------
const bullets = (t) => t.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
function expiryClass(s) {
  if (/expired|expires today/.test(s)) return "bad";
  const m = s.match(/expires in (\d+) day/);
  if (!m) return "";
  return +m[1] <= 1 ? "bad" : +m[1] <= 3 ? "warn" : "";
}
function tags(list, cls) {
  const box = el("div", "tags");
  for (const t of list) box.append(el("span", `tag ${cls}`, t));
  return box;
}
const splitList = (s) => (s && s !== "nothing" && s !== "n/a" ? s.split(", ").map((x) => x.trim()).filter(Boolean) : []);

function recipeCards(text) {
  const row = el("div", "carousel");
  for (const block of text.split(/\n(?=\d+\. )/).slice(1)) {
    const ls = block.split("\n");
    const m = ls[0].match(/^\d+\. (.+?) \((\d+) min, serves (\d+)\)/);
    if (!m) continue;
    const card = el("div", "card");
    card.append(el("h3", "", m[1]), el("div", "meta", `⏱ ${m[2]} min · serves ${m[3]}`));
    const uses = ls.find((l) => l.trim().startsWith("Uses:"));
    const missing = ls.find((l) => l.trim().startsWith("Missing:"));
    if (uses) card.append(tags(splitList(uses.split("Uses:")[1].trim()), "use"));
    if (missing) card.append(tags(splitList(missing.split("Missing:")[1].trim()).map((x) => `buy ${x}`), "buy"));
    const steps = ls.filter((l) => /^\s+\d+\) /.test(l)).map((l) => l.replace(/^\s+\d+\) /, ""));
    if (steps.length) {
      const ol = el("ol");
      for (const s of steps) ol.append(el("li", "", s));
      card.append(ol);
    }
    row.append(card);
  }
  return row.childElementCount ? row : null;
}

function planCards(text) {
  const row = el("div", "carousel");
  for (const line of bullets(text)) {
    const m = line.match(/^(.+?): (.+?) \((\d+) min\)(?:, buy (.+))?$/);
    if (!m) continue;
    const card = el("div", "card");
    card.append(el("div", "meta", m[1]), el("h3", "", m[2]), el("div", "meta", `⏱ ${m[3]} min`));
    if (m[4]) card.append(tags(m[4].split(", ").map((x) => `buy ${x}`), "buy"));
    row.append(card);
  }
  return row.childElementCount ? row : null;
}

function orderCard(text) {
  const card = el("div", "card receipt");
  const id = (text.match(/order (PP-\d+)/i) || [])[1] || "";
  card.append(el("h3", "", `🛒 Order ${id}`), el("div", "meta", "Demo Grocer (simulated) · nothing charged yet"));
  for (const l of bullets(text)) {
    const m = l.match(/^(\d+) x (.+) @ (\$[\d.]+) = (\$[\d.]+)$/);
    if (!m) continue;
    const line = el("div", "line");
    line.append(el("span", "", `${m[1]} × ${m[2]}`), el("span", "", m[4]));
    card.append(line);
  }
  const total = (text.match(/comes to (\$[\d.]+)/) || [])[1];
  if (total) {
    const t = el("div", "line total");
    t.append(el("span", "", "Total incl. delivery"), el("span", "", total));
    card.append(t);
  }
  const actions = el("div", "actions");
  const yes = el("button", "btn primary", "Place order");
  const no = el("button", "btn ghost", "Not now");
  yes.onclick = () => send("Yes, place the order");
  no.onclick = () => send("No, don't place the order");
  actions.append(yes, no);
  card.append(actions);
  return card;
}

function listCard(title, items, withExpiry) {
  if (!items.length) return null;
  const card = el("div", "card");
  card.append(el("h3", "", title));
  const ul = el("ul", "rows");
  for (const it of items) {
    const li = el("li");
    li.append(el("span", `dot ${withExpiry ? expiryClass(it) : ""}`), el("span", "", it));
    ul.append(li);
  }
  card.append(ul);
  return card;
}

function cardFor(c) {
  if (c.isError) return el("div", "card error", c.result.split("\n")[0]);
  switch (c.name) {
    case "suggest_recipes": return recipeCards(c.result);
    case "plan_meals":
    case "get_meal_plan": return planCards(c.result);
    case "prepare_grocery_order": return orderCard(c.result);
    case "list_pantry": return listCard("🥫 Pantry", bullets(c.result), true);
    case "scan_groceries": return listCard("📸 Found in your photo", bullets(c.result), true);
    case "get_shopping_list": return listCard("📝 Shopping list", bullets(c.result), false);
    case "update_household_profile": {
      const saved = c.result.split("\n")[0].replace(/^(Saved\. )?Household: /, "").replace(/\.$/, "");
      const card = listCard("✅ Saved to household memory", saved.split("; "), false);
      if (card) card.classList.add("success");
      return card;
    }
    case "rate_recipe": return el("div", "card success", `💾 ${c.result}`);
    case "get_household_profile": {
      const line = c.result.split("\n")[0].replace(/^(Saved\. )?Household: /, "").replace(/\.$/, "");
      return listCard("🏠 Household", [...line.split("; "), ...bullets(c.result)], false);
    }
    case "confirm_grocery_order":
    case "receive_grocery_order": return el("div", "card success", `✅ ${c.result.split("\n")[0]}`);
    default: return null;
  }
}

// Prefer neural/online voices (Edge: "Microsoft Aria/Jenny Online (Natural)", Chrome: "Google US English").
function bestVoice() {
  if (!("speechSynthesis" in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.startsWith("en"));
  const prefs = [/Natural/i, /Online/i, /Google US English/i, /Samantha/i, /Jenny|Aria/i];
  for (const p of prefs) {
    const v = voices.find((x) => p.test(x.name));
    if (v) return v;
  }
  return voices[0] || null;
}
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // voices load lazily in some browsers

// ---------- Voice out: Amazon Polly, with browser speech as fallback ----------
async function speak(text) {
  if (state.muted || !text) return setRing("");
  setRing("speaking");
  try {
    if (state.pollyOff) throw new Error("Polly unavailable");
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    state.audio = audio;
    audio.onended = () => { setRing(""); URL.revokeObjectURL(url); };
    await audio.play();
  } catch (err) {
    state.pollyOff = true; // don't add Polly latency to every reply once it has failed
    if (!state.voiceWarned) {
      state.voiceWarned = true;
      const li = el("li", "err");
      li.append(el("span", "name", "Amazon Polly"), el("div", "", `Using browser voice instead: ${err.message}`));
      $("mcpLog").prepend(li);
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      const voice = bestVoice();
      if (voice) u.voice = voice;
      u.rate = 1.03;
      u.onend = () => setRing("");
      speechSynthesis.speak(u);
    } else setRing("");
  }
}
function stopSpeaking() {
  if (state.audio) state.audio.pause();
  state.audio = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- Voice in: Web Speech API (Chrome / Edge) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) {
  $("micBtn").disabled = true;
  $("micBtn").title = "Voice input needs Chrome or Edge";
}
$("micBtn").onclick = () => {
  if (!SR || state.busy) return;
  if (state.rec) return state.rec.stop();
  stopSpeaking();
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  let heard = "";
  rec.onresult = (e) => {
    heard = Array.from(e.results).map((r) => r[0].transcript).join("");
    $("userSaid").textContent = `“${heard}”`;
  };
  rec.onerror = (e) => { $("userSaid").textContent = `(mic: ${e.error})`; };
  rec.onend = () => {
    state.rec = null;
    $("micBtn").classList.remove("on");
    setRing("");
    if (heard.trim()) send(heard);
  };
  state.rec = rec;
  $("micBtn").classList.add("on");
  setRing("listening");
  rec.start();
};

// ---------- Photo scan ----------
async function downscale(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
$("photoInput").onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file || state.busy) return;
  state.busy = true;
  stopSpeaking();
  const source = $("photoSource").value;
  $("userSaid").textContent = `📷 ${file.name}`;
  $("alexaSays").textContent = "Looking at your photo…";
  setRing("thinking");
  try {
    const image = await downscale(file);
    render(await api("/api/scan", { image, source }));
    const img = el("img", "photo");
    img.src = image;
    img.alt = "Scanned photo";
    $("cards").prepend(img);
  } catch (err) {
    $("alexaSays").textContent = `I couldn't read that photo: ${err.message}`;
    setRing("");
  } finally {
    state.busy = false;
  }
};

// ---------- Controls ----------
$("textInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send(e.target.value); });
$("muteBtn").onclick = () => {
  state.muted = !state.muted;
  $("muteBtn").textContent = state.muted ? "🔇" : "🔊";
  if (state.muted) { stopSpeaking(); setRing(""); }
};
$("mcpBtn").onclick = () => document.body.classList.toggle("hide-mcp");
$("resetBtn").onclick = async () => {
  stopSpeaking();
  await api("/api/reset").catch(() => {});
  $("userSaid").textContent = "";
  $("alexaSays").textContent = "New conversation. What would you like to do?";
  $("cards").replaceChildren();
  $("mcpLog").replaceChildren();
  showChips(STARTERS);
  setRing("");
};
