// rain-alert Cloudflare Worker:
// - Telegram webhook: answers commands, buttons and access requests the moment they arrive
// - cron triggers: start the GitHub workflow that sends rain warnings (rain-alert/rain_alert.py)
// - /api/*: lets that workflow read who gets alerts (settings live in Cloudflare KV, see below)

const STATUS_PREFIX = "📌 Rain alert status:"; // old pinned format, read once for migration
const TZ = "America/Montevideo";
const LATITUDE = -34.91; // rounded to ~1 km on purpose; same forecast grid point as the exact address
const LONGITUDE = -56.15;
const SLOT = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LOOKAHEAD = 3 * HOUR;

const HELP = "Commands:\n/now – current rain outlook\n/off – stop rain warnings\n/on – turn warnings back on\n/status – show whether warnings are on";
const OWNER_HELP = `${HELP}\n/users – who has access`;
const WARNINGS_ON_BUTTON = { inline_keyboard: [[{ text: "🔔 Warnings on", callback_data: "on" }]] };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (request.method !== "POST") return new Response("rain-alert-bot");
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      await handleUpdate(await request.json(), env);
    } catch (err) {
      // Never log the error object itself: keep anything token-bearing out of the logs.
      console.log(`update failed: ${err instanceof TelegramError || err instanceof SettingsError ? err.message : err?.name}`);
    }
    return new Response("ok"); // always 200, or Telegram re-sends the same update
  },

  // Cloudflare cron trigger (see [triggers] in wrangler.toml): start the GitHub workflow.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(startCheck(event, env));
  },
};

// ------------------------------------------------------------------ schedule

const SLOT_MODES = { "7 10 * * *": "daily", "7 23 * * *": "evening" }; // anything else: hourly

export async function startCheck(event, env) {
  const mode = SLOT_MODES[event.cron] || "hourly";
  const scheduledAt = new Date(event.scheduledTime).toISOString();
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/rain-alert.yml/dispatches`;
  let status = 0;
  for (let attempt = 0; attempt < 3 && status !== 204; attempt++) {
    if (attempt) await sleep(5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "rain-alert-bot",
        },
        body: JSON.stringify({ ref: "main", inputs: { mode, scheduled_at: scheduledAt } }),
      });
      status = res.status;
      if ([401, 403, 404, 422].includes(status)) break; // won't fix itself by retrying
    } catch {
      status = 0;
    }
  }
  if (status === 204) return;
  console.log(`starting the ${mode} check failed: HTTP ${status}`);
  if (mode === "daily") {
    // Once a day at most, so an expired token doesn't mean silence nobody notices.
    const ownerId = env.ADMIN_CHAT_IDS.split(",")[0].trim();
    const why = status === 401 ? "the GitHub token was rejected – it may have expired"
      : status === 0 ? "GitHub didn't answer" : `GitHub answered HTTP ${status}`;
    await send(env, ownerId, `⚠️ I couldn't start this morning's rain check: ${why}. See "Troubleshooting" in the README.`).catch(() => {});
  }
}

// ------------------------------------------------------------------ settings (Cloudflare KV)
//
// One JSON document under the key "state" in the STATE KV namespace:
//   { version: 1,
//     chats:    { "<chat id>": { on: true, muted: "2026-11-13" | null } },
//     approved: [ { name, id } ],   people/groups the owner approved
//     pending:  [ { name, id } ] }  requests waiting for the owner
// The previous version is kept under "state:prev". Deploys and code changes never touch it.
// Safety rules: if the settings can't be read, nothing is written; and a change that would drop
// an approved person is refused (and the owner told) unless it comes from /users → Remove.

const STATE_KEY = "state";

export class SettingsError extends Error {}

function blankState() {
  return { version: 1, chats: {}, approved: [], pending: [] };
}

export async function loadSettings(env) {
  let raw;
  try {
    raw = await env.STATE.get(STATE_KEY);
  } catch {
    throw new SettingsError("settings storage unavailable");
  }
  if (raw) return JSON.parse(raw);
  return migrateFromPinned(env);
}

// First run only: copy what the old pinned status messages held, then store it.
async function migrateFromPinned(env) {
  const admins = adminIds(env);
  const state = blankState();
  let note = "📦 Settings are now kept in permanent storage (no pinned message needed any more).";
  try {
    const owner = parseState((await tg(env, "getChat", { chat_id: admins[0] })).pinned_message);
    state.chats[admins[0]] = { on: owner.on, muted: owner.muted };
    state.approved = owner.approved;
    state.pending = owner.pending;
    for (const u of owner.approved) {
      const s = parseState((await tg(env, "getChat", { chat_id: u.id })).pinned_message);
      state.chats[u.id] = { on: s.on, muted: s.muted };
    }
    note += ` Copied: ${owner.approved.length} approved, ${owner.pending.length} waiting. You can unpin the old status message.`;
  } catch {
    note += " The old status message couldn't be read, so I started with only you having access.";
  }
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  await send(env, admins[0], note).catch(() => {});
  return state;
}

export async function saveSettings(env, before, after, { removing = [] } = {}) {
  const dropped = before.approved.filter(
    (u) => !after.approved.some((a) => a.id === u.id) && !removing.includes(u.id));
  if (dropped.length) {
    await send(env, adminIds(env)[0], `⚠️ I blocked a change that would have removed access for ${dropped.map((u) => u.name).join(", ")}. Nothing was changed. Please report this – it's a bug.`).catch(() => {});
    throw new SettingsError("refused: would drop approved users");
  }
  await env.STATE.put("state:prev", JSON.stringify(before));
  await env.STATE.put(STATE_KEY, JSON.stringify(after));
}

export function chatSettings(state, chatId, today = localDate()) {
  const s = state.chats[chatId] || { on: true, muted: null };
  return { on: s.on !== false, muted: s.muted && s.muted >= today ? s.muted : null };
}

function adminIds(env) {
  return env.ADMIN_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ API for the GitHub job

async function handleApi(request, env, url) {
  if (!env.STATE_SECRET || request.headers.get("authorization") !== `Bearer ${env.STATE_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  try {
    const state = await loadSettings(env);
    if (request.method === "GET" && url.pathname === "/api/recipients") {
      const ids = [...new Set([...adminIds(env), ...state.approved.map((u) => u.id)])];
      return json(200, { chats: ids.map((id) => ({ id, ...chatSettings(state, id) })) });
    }
    if (request.method === "POST" && url.pathname === "/api/unmute") {
      const { chat_id: id } = await request.json();
      const after = structuredClone(state);
      if (after.chats[id]?.muted) {
        after.chats[id].muted = null;
        await saveSettings(env, state, after);
      }
      return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  } catch (err) {
    console.log(`api failed: ${err?.message || err?.name}`);
    return json(503, { error: "settings unavailable" });
  }
}

// ------------------------------------------------------------------ updates

export async function handleUpdate(update, env) {
  const admins = adminIds(env);
  const ownerId = admins[0];
  const cb = update.callback_query;
  const msg = cb ? cb.message : update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const action = cb ? cb.data || "" : commandOf(msg.text);

  try {
    let state;
    try {
      state = await loadSettings(env);
    } catch (err) {
      // Never guess: without the settings we change nothing.
      if (action || cb) await send(env, chatId, "⚠️ My settings are temporarily unavailable, so I didn't change anything. Please try again in a minute.").catch(() => {});
      throw err;
    }
    const before = structuredClone(state);
    const isAdmin = admins.includes(chatId);
    if (!isAdmin && !state.approved.some((u) => u.id === chatId)) {
      if (!cb) await handleStranger(env, ownerId, before, state, msg);
      return;
    }
    const today = localDate();
    const mine = chatSettings(state, chatId, today);
    const setMine = (s) => { state.chats[chatId] = s; };

    const [verb, target] = action.split(":");
    if (isAdmin && ["approve", "decline", "remove"].includes(verb) && target) {
      await handleAdminDecision(env, ownerId, before, state, verb, target, cb);
    } else if (verb === "off") {
      setMine({ ...mine, on: false });
      await saveSettings(env, before, state);
      await send(env, chatId, "🔕 Rain warnings are off. You'll still get the morning and evening summaries.", WARNINGS_ON_BUTTON);
    } else if (verb === "on") {
      setMine({ on: true, muted: null });
      await saveSettings(env, before, state);
      await send(env, chatId, "🔔 Rain warnings are on.");
    } else if (verb === "clothes_in") {
      setMine({ ...mine, muted: today });
      await saveSettings(env, before, state);
      await send(env, chatId, "👕 Got it – no more rain warnings today. I'll still tell you when it's dry again.");
    } else if (verb === "now") {
      await send(env, chatId, await nowMessage(env));
    } else if (verb === "status") {
      let status = mine.on ? "🔔 Rain warnings are on." : "🔕 Rain warnings are off.";
      if (mine.on && mine.muted === today) status += " Muted for the rest of today (clothes are in).";
      await send(env, chatId, `${status}\n\n${isAdmin ? OWNER_HELP : HELP}`);
    } else if (verb === "users" && isAdmin) {
      await sendUserList(env, chatId, state);
    } else if (verb === "start" || verb === "help") {
      await send(env, chatId, `☔ I warn you about rain at home.\n\n${isAdmin ? OWNER_HELP : HELP}`);
    }
  } finally {
    if (cb) await tg(env, "answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
  }
}

function commandOf(text) {
  const t = (text || "").trim();
  // "/now" or "/now@MyBot" -> "now"; anything that isn't a command -> ""
  return t.startsWith("/") ? t.split(/\s+/)[0].slice(1).split("@")[0].toLowerCase() : "";
}

async function handleStranger(env, ownerId, before, state, msg) {
  const chatId = String(msg.chat.id);
  if (state.pending.some((u) => u.id === chatId)) {
    await send(env, chatId, "⏳ Your request is still waiting for the owner. You'll get a message here when they decide.");
    return;
  }
  const name = displayName(msg);
  const username = msg.chat.type === "private" && msg.from?.username ? ` (@${msg.from.username})` : "";
  state.pending.push({ name, id: chatId });
  await saveSettings(env, before, state); // record it first, so repeat messages don't re-notify
  await send(env, ownerId, `👤 ${name}${username} wants rain alerts${msg.chat.type === "private" ? "" : " in their group"}.`, {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `approve:${chatId}` },
      { text: "❌ Decline", callback_data: `decline:${chatId}` },
    ]],
  });
  await send(env, chatId, "👋 Hi! This bot sends rain alerts for one home. I've asked the owner to give you access – you'll get a message here as soon as they decide.");
}

async function handleAdminDecision(env, ownerId, before, state, verb, target, cb) {
  const pending = state.pending.find((u) => u.id === target);
  const approved = state.approved.find((u) => u.id === target);
  let note;
  if (verb === "approve") {
    if (!pending) {
      note = approved ? `${approved.name} already has access.` : "That request is no longer pending.";
    } else {
      state.pending = state.pending.filter((u) => u.id !== target);
      state.approved.push(pending);
      await saveSettings(env, before, state);
      note = `✅ ${pending.name} approved. They'll get rain alerts from the next check.`;
      await send(env, target, `✅ You're in! You'll get rain alerts for home.\n\n${HELP}`).catch(() => {});
    }
  } else if (verb === "decline") {
    if (!pending) {
      note = "That request is no longer pending.";
    } else {
      state.pending = state.pending.filter((u) => u.id !== target);
      await saveSettings(env, before, state);
      note = `❌ ${pending.name} declined.`;
      await send(env, target, "Sorry, the owner didn't approve access to these rain alerts.").catch(() => {});
    }
  } else if (verb === "remove") {
    if (!approved) {
      note = "They no longer have access.";
    } else {
      state.approved = state.approved.filter((u) => u.id !== target);
      delete state.chats[target];
      await saveSettings(env, before, state, { removing: [target] });
      note = `🚫 ${approved.name} removed. They won't get rain alerts any more.`;
      await send(env, target, "Your access to these rain alerts was removed by the owner.").catch(() => {});
    }
  }
  if (cb && verb !== "remove") {
    // Replace the request's buttons with the outcome, so it can't be tapped twice.
    await tg(env, "editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: note }).catch(() => {});
  } else {
    await send(env, ownerId, note);
  }
}

async function sendUserList(env, chatId, state) {
  if (!state.approved.length && !state.pending.length) {
    await send(env, chatId, "Only you have access. When someone messages the bot, you'll get a request to approve here.");
    return;
  }
  const lines = [
    ...state.approved.map((u) => `👤 ${u.name}`),
    ...state.pending.map((u) => `⏳ ${u.name} (waiting for your answer above)`),
  ];
  const buttons = state.approved.map((u) => [{ text: `🚫 Remove ${u.name}`, callback_data: `remove:${u.id}` }]);
  await send(env, chatId, `People with access besides you:\n${lines.join("\n")}`, buttons.length ? { inline_keyboard: buttons } : undefined);
}

function displayName(msg) {
  const raw = msg.chat.type === "private"
    ? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")
    : msg.chat.title;
  const name = (raw || "").replace(/[\r\n]+/g, " ").trim().slice(0, 40);
  return name || "Someone";
}

// ------------------------------------------------------------------ old pinned format (migration only)

export function parseState(pinned) {
  const state = { on: true, muted: null, approved: [], pending: [] };
  const text = pinned?.text || "";
  if (!pinned?.from?.is_bot || !text.startsWith(STATUS_PREFIX)) return state;
  const lines = text.split("\n");
  state.on = !lines[0].includes("OFF");
  for (const line of lines) {
    let m;
    if ((m = line.match(/Warnings muted for today \((\d{4}-\d{2}-\d{2})\)/))) state.muted = m[1];
    else if ((m = line.match(/^👤 (.+) – (-?\d+)$/u))) state.approved.push({ name: m[1], id: m[2] });
    else if ((m = line.match(/^⏳ (.+) – (-?\d+)$/u))) state.pending.push({ name: m[1], id: m[2] });
  }
  return state;
}

// ------------------------------------------------------------------ telegram

export class TelegramError extends Error {}

async function tg(env, method, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      await sleep(1000);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body.result;
    if (res.status === 429) {
      await sleep(Math.min(body.parameters?.retry_after ?? 1, 5) * 1000);
    } else if (res.status < 500) {
      throw new TelegramError(`${method} HTTP ${res.status}: ${body.description || ""}`);
    } else {
      await sleep(1000);
    }
  }
  throw new TelegramError(`${method} failed after retries`);
}

function send(env, chatId, text, replyMarkup) {
  return tg(env, "sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ forecast (/now)
// Mirrors rain_alert.py. Times are Montevideo local, held as "naive" UTC timestamps.

function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

export async function fetchForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&minutely_15=precipitation&hourly=precipitation_probability&timezone=${encodeURIComponent(TZ)}&forecast_days=2`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
    } catch {
      // retry once
    }
  }
  return null;
}

export function buildSlots(data, nowUtcMs = Date.now()) {
  const now = nowUtcMs + data.utc_offset_seconds * 1000;
  const prob = new Map(data.hourly.time.map((t, i) => [Date.parse(`${t}Z`), data.hourly.precipitation_probability[i]]));
  const slots = [];
  data.minutely_15.time.forEach((t, i) => {
    const end = Date.parse(`${t}Z`);
    const start = end - SLOT;
    const mm = data.minutely_15.precipitation[i];
    const p = prob.get(Math.floor(start / HOUR) * HOUR + HOUR);
    if (end > now && mm != null && p != null) slots.push({ start, mm, prob: p });
  });
  return { now, slots };
}

function covered(now, slots, until) {
  const have = new Set(slots.map((s) => s.start));
  for (let t = Math.floor(now / SLOT) * SLOT; t < until; t += SLOT) if (!have.has(t)) return false;
  return true;
}

export function outlook(env, now, slots) {
  const mmLimit = Number(env.RAIN_MM_THRESHOLD || 0.2);
  const probLimit = Number(env.RAIN_PROB_THRESHOLD || 40);
  const isRain = (s) => s.mm >= mmLimit || s.prob >= probLimit;

  let warning = "✅ No rain expected in the next 3 hours.";
  for (let i = 0; i < slots.length && slots[i].start < now + LOOKAHEAD; i++) {
    const s = slots[i];
    if (!isRain(s)) continue;
    const minutes = Math.max(0, (s.start - now) / 60000);
    const label = minutes < 30 ? "RAINING NOW" : minutes < 90 ? "RAIN IN ~1 HOUR" : minutes < 150 ? "RAIN IN ~2 HOURS" : null;
    if (label) {
      const mm = slots.slice(i, i + 4).reduce((a, x) => a + x.mm, 0);
      warning = `☔ ${label} – Bring in the clothes. Rain around ${hhmm(Math.max(s.start, now))}, ${s.prob}% chance, ${mm.toFixed(1)} mm.`;
    }
    break;
  }

  const midnight = Math.floor(now / (24 * HOUR)) * 24 * HOUR + 24 * HOUR;
  const today = slots.filter((s) => s.start < midnight);
  const hours = new Map();
  for (const s of today) {
    const h = Math.floor(s.start / HOUR) * HOUR;
    const [rain, peak] = hours.get(h) || [false, 0];
    hours.set(h, [rain || isRain(s), Math.max(peak, s.prob)]);
  }
  const windows = [];
  for (const h of [...hours.keys()].sort((a, b) => a - b)) {
    const [rain, p] = hours.get(h);
    if (!rain) continue;
    const last = windows[windows.length - 1];
    if (last && last.end === h) {
      last.end = h + HOUR;
      last.peak = Math.max(last.peak, p);
    } else {
      windows.push({ start: h, end: h + HOUR, peak: p });
    }
  }
  let summary = "☀️ No rain expected today. Good day to dry clothes outside.";
  if (windows.length) {
    const total = today.reduce((a, s) => a + s.mm, 0);
    const advice = windows[0].start <= now
      ? "No rain-free window before the first rain – keep the clothes inside."
      : `Hang the clothes before ${hhmm(windows[0].start)}.`;
    const listed = windows.map((w) => `${hhmm(w.start)}-${w.end >= midnight ? "23:59" : hhmm(w.end)} (peak ${w.peak}%)`).join(", ");
    summary = `🌦 Today's rain forecast: ${listed}. Total ~${total.toFixed(1)} mm. ${advice}`;
  }
  return `${warning}\n${summary}`;
}

async function nowMessage(env) {
  const data = await fetchForecast();
  if (!data) return "⚠️ The forecast service isn't answering right now. Try /now again in a few minutes.";
  const { now, slots } = buildSlots(data);
  const midnight = Math.floor(now / (24 * HOUR)) * 24 * HOUR + 24 * HOUR;
  if (!covered(now, slots, Math.max(midnight, now + LOOKAHEAD))) {
    return "⚠️ The forecast is incomplete right now, so I can't give a reliable answer. Try /now again later.";
  }
  return outlook(env, now, slots);
}
