// Pantry Pal simulated Alexa+ front end.
// Model and tool text is always rendered with textContent. Only the static icon strings below use innerHTML.
const $ = (id) => document.getElementById(id);
const state = { muted: false, busy: false, audio: null, rec: null, pollyOff: false, voiceWarned: false };

const ICON_SOUND_ON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const ICON_SOUND_OFF =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 6 6"/><path d="m22 9-6 6"/></svg>';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- Status line and activity bar ----------
const STATUS = {
  listening: "Listening. Speak now, or tap the mic again when you're done",
  thinking: "Thinking",
  speaking: "Speaking. Tap the mic to interrupt",
  "": "Ready. Tap the mic or type to talk",
};
function setRing(mode) {
  $("ring").className = `ring ${mode || ""}`;
  $("status").dataset.mode = mode || "";
  $("status").textContent = STATUS[mode || ""];
}
const setStatus = (text) => ($("status").textContent = text);

// ---------- Clock ----------
const tick = () => ($("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));

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
  update_household_profile: ["What can I cook tonight?", "What do you remember about us?"],
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
  $("userSaid").textContent = `"${text}"`;
  $("textInput").value = "";
  $("alexaSays").textContent = "...";
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

// ---------- Tool call log ----------
function logCall(c) {
  const li = el("li", c.isError ? "err" : "");
  li.append(el("span", "name", c.name), el("span", "ms", `${c.ms} ms`));
  const args = { ...c.input };
  if (typeof args.image_base64 === "string") args.image_base64 = `<${Math.round(args.image_base64.length / 1024)} KB image>`;
  li.append(el("div", "args", JSON.stringify(args)));
  const d = el("details");
  d.append(el("summary", "", c.isError ? "error" : "result"), el("pre", "", c.result));
  li.append(d);
  $("mcpLog").prepend(li);
}

function logNote(name, text) {
  const li = el("li", "err");
  li.append(el("span", "name", name), el("div", "args", text));
  $("mcpLog").prepend(li);
}

// ---------- Cards ----------
const bullets = (t) => t.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
const splitList = (s) => (s && s !== "nothing" && s !== "n/a" ? s.split(", ").map((x) => x.trim()).filter(Boolean) : []);

function expiryClass(s) {
  if (/expired|expires today/.test(s)) return "bad";
  const m = s.match(/(\d+) day/);
  if (!m) return "";
  return +m[1] <= 1 ? "bad" : +m[1] <= 3 ? "warn" : "ok";
}

function card(label, title, extraClass) {
  const c = el("div", `card${extraClass ? ` ${extraClass}` : ""}`);
  if (label) c.append(el("div", "card-label", label));
  if (title) c.append(el("h3", "card-title", title));
  return c;
}

function tags(list, cls) {
  const box = el("div", "tags");
  for (const t of list) box.append(el("span", `tag ${cls}`, t));
  return box;
}

function recipeCards(text) {
  const row = el("div", "carousel");
  for (const block of text.split(/\n(?=\d+\. )/).slice(1)) {
    const ls = block.split("\n");
    const m = ls[0].match(/^\d+\. (.+?) \((\d+) min, serves (\d+)\)/);
    if (!m) continue;
    const c = card("Recipe", m[1]);
    c.append(el("div", "meta", `${m[2]} min · serves ${m[3]}`));
    const uses = ls.find((l) => l.trim().startsWith("Uses:"));
    const missing = ls.find((l) => l.trim().startsWith("Missing:"));
    if (uses) c.append(tags(splitList(uses.split("Uses:")[1].trim()), "use"));
    if (missing) {
      const buy = splitList(missing.split("Missing:")[1].trim());
      if (buy.length) c.append(tags(buy.map((x) => `buy ${x}`), "buy"));
    }
    const steps = ls.filter((l) => /^\s+\d+\) /.test(l)).map((l) => l.replace(/^\s+\d+\) /, ""));
    if (steps.length) {
      const ol = el("ol");
      for (const s of steps) ol.append(el("li", "", s));
      c.append(ol);
    }
    row.append(c);
  }
  return row.childElementCount ? row : null;
}

function planCards(text) {
  const row = el("div", "carousel");
  for (const line of bullets(text)) {
    const m = line.match(/^(.+?): (.+?) \((\d+) min\)(?:, buy (.+))?$/);
    if (!m) continue;
    const c = card(m[1], m[2]);
    c.append(el("div", "meta", `${m[3]} min`));
    if (m[4]) c.append(tags(m[4].split(", ").map((x) => `buy ${x}`), "buy"));
    row.append(c);
  }
  return row.childElementCount ? row : null;
}

function orderCard(text) {
  const id = (text.match(/order (PP-\d+)/i) || [])[1] || "";
  const c = card(`Order ${id}`, "Demo Grocer (simulated)", "receipt");
  c.append(el("div", "meta", "Nothing is charged until you confirm"));
  for (const l of bullets(text)) {
    const m = l.match(/^(\d+) x (.+) @ (\$[\d.]+) = (\$[\d.]+)$/);
    if (!m) continue;
    const line = el("div", "line");
    line.append(el("span", "", `${m[1]} × ${m[2]}`), el("span", "", m[4]));
    c.append(line);
  }
  const total = (text.match(/comes to (\$[\d.]+)/) || [])[1];
  if (total) {
    const t = el("div", "line total");
    t.append(el("span", "", "Total incl. delivery"), el("span", "", total));
    c.append(t);
  }
  const actions = el("div", "actions");
  const yes = el("button", "btn primary", "Place order");
  const no = el("button", "btn ghost", "Not now");
  yes.onclick = () => send("Yes, place the order");
  no.onclick = () => send("No, don't place the order");
  actions.append(yes, no);
  c.append(actions);
  return c;
}

/** A list card. Items like "6 eggs (expires in 3 days)" become a name plus a coloured badge. */
function listCard(label, items, extraClass) {
  if (!items.length) return null;
  const c = card(label, "", extraClass);
  const ul = el("ul", "rows");
  for (const it of items) {
    const li = el("li");
    const m = it.match(/^(.*?) \(((?:expires|expired|about|for) .+)\)$/);
    if (m) {
      li.append(el("span", "", m[1]), el("span", `badge ${expiryClass(m[2])}`, m[2]));
    } else {
      li.append(el("span", "", it));
    }
    ul.append(li);
  }
  c.append(ul);
  return c;
}

const firstLine = (t) => t.split("\n")[0];
const profileItems = (t) =>
  firstLine(t).replace(/^(Saved\. )?Household: /, "").replace(/\.$/, "").split("; ").concat(bullets(t));

function cardFor(c) {
  if (c.isError) return el("div", "card error", firstLine(c.result));
  switch (c.name) {
    case "suggest_recipes": return recipeCards(c.result);
    case "plan_meals":
    case "get_meal_plan": return planCards(c.result);
    case "prepare_grocery_order": return orderCard(c.result);
    case "list_pantry": return listCard("Pantry", bullets(c.result));
    case "scan_groceries": return listCard("Found in your photo", bullets(c.result));
    case "get_shopping_list": return listCard("Shopping list", bullets(c.result));
    case "update_household_profile": return listCard("Saved to household memory", profileItems(c.result), "success");
    case "get_household_profile": return listCard("Household memory", profileItems(c.result));
    case "rate_recipe": {
      const r = card("Remembered", "", "success");
      r.append(el("div", "", c.result));
      return r;
    }
    case "confirm_grocery_order":
    case "receive_grocery_order": {
      const r = card(c.name === "confirm_grocery_order" ? "Order placed" : "Delivered", "", "success");
      r.append(el("div", "", firstLine(c.result)));
      return r;
    }
    default: return null;
  }
}

// ---------- Voice out: Amazon Polly, falling back to the most natural browser voice ----------
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
    audio.onended = () => {
      setRing("");
      URL.revokeObjectURL(url);
    };
    await audio.play();
  } catch (err) {
    state.pollyOff = true; // don't add Polly latency to every reply once it has failed
    if (!state.voiceWarned) {
      state.voiceWarned = true;
      logNote("Amazon Polly", `Using browser voice instead: ${err.message}`);
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
const MIC_ERRORS = {
  "not-allowed": "Microphone blocked. Click the icon at the left of the address bar, allow the microphone, then reload.",
  "service-not-allowed": "This browser blocked speech recognition. Try Chrome, or type instead.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  "audio-capture": "No microphone found. Check your mic in Windows sound settings.",
  network: "Speech recognition needs the internet. Try Chrome, or type instead.",
  aborted: "",
};

$("micBtn").onclick = () => {
  if (!SR || state.busy) return;
  if (state.rec) return state.rec.stop();
  stopSpeaking();
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let heard = "";
  let micError = "";
  const guard = setTimeout(() => rec.stop(), 12000); // some browsers never end if nothing is said
  rec.onstart = () => setRing("listening");
  rec.onspeechend = () => setStatus("Got it");
  rec.onresult = (e) => {
    heard = Array.from(e.results).map((r) => r[0].transcript).join("");
    $("userSaid").textContent = `"${heard}"`;
  };
  rec.onerror = (e) => {
    micError = e.error in MIC_ERRORS ? MIC_ERRORS[e.error] : `Mic error: ${e.error}`;
  };
  rec.onend = () => {
    clearTimeout(guard);
    state.rec = null;
    $("micBtn").classList.remove("on");
    setRing("");
    if (heard.trim()) send(heard);
    else setStatus(micError || "I didn't catch that. Tap the mic and try again.");
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
  $("userSaid").textContent = `Photo: ${file.name}`;
  $("alexaSays").textContent = "Looking at your photo...";
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
$("textInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") send(e.target.value);
});
$("muteBtn").onclick = () => {
  state.muted = !state.muted;
  $("muteBtn").innerHTML = state.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
  $("muteBtn").title = state.muted ? "Unmute voice" : "Mute voice";
  if (state.muted) {
    stopSpeaking();
    setRing("");
  }
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

// ---------- Init ----------
$("muteBtn").innerHTML = ICON_SOUND_ON;
tick();
setInterval(tick, 15000);
showChips(STARTERS);
setRing("");
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // voices load lazily in some browsers
if (!SR) {
  $("micBtn").disabled = true;
  $("micBtn").title = "Voice input needs Chrome or Edge";
  setStatus("Voice input isn't supported in this browser. Use Chrome or Edge, or type below.");
}
