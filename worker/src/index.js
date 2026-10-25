// Telegram webhook for the rain-alert bot: answers commands, buttons and access requests
// the moment they arrive. Scheduled rain warnings are sent by rain-alert/rain_alert.py.
//
// State lives in a message the bot pins in each chat (same format as rain_alert.py):
//   📌 Rain alert status: ON 🔔
//   👕 Warnings muted for today (2026-10-23)     (optional)
//   👤 Ana – 123456789                            (owner's chat only: approved users)
//   ⏳ Bruno – 987654321                          (owner's chat only: waiting for approval)
//   Commands: /now /on /off /status

const STATUS_PREFIX = "📌 Rain alert status:";
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
    if (request.method !== "POST") return new Response("rain-alert-bot");
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      await handleUpdate(await request.json(), env);
    } catch (err) {
      // Never log the error object itself: keep anything token-bearing out of the logs.
      console.log(`update failed: ${err instanceof TelegramError ? err.message : err?.name}`);
    }
    return new Response("ok"); // always 200, or Telegram re-sends the same update
  },
};

// ------------------------------------------------------------------ updates

export async function handleUpdate(update, env) {
  const admins = env.ADMIN_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const ownerId = admins[0];
  const cb = update.callback_query;
  const msg = cb ? cb.message : update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const action = cb ? cb.data || "" : commandOf(msg.text);

  try {
    const owner = await loadState(env, ownerId);
    const isAdmin = admins.includes(chatId);
    if (!isAdmin && !owner.approved.some((u) => u.id === chatId)) {
      if (!cb) await handleStranger(env, ownerId, owner, msg);
      return;
    }
    const state = chatId === ownerId ? owner : await loadState(env, chatId);
    const today = localDate();
    if (state.muted && state.muted < today) state.muted = null;

    const [verb, target] = action.split(":");
    if (isAdmin && ["approve", "decline", "remove"].includes(verb) && target) {
      await handleAdminDecision(env, ownerId, owner, verb, target, cb);
    } else if (verb === "off") {
      state.on = false;
      await saveState(env, chatId, state);
      await send(env, chatId, "🔕 Rain warnings are off. You'll still get the morning and evening summaries.", WARNINGS_ON_BUTTON);
    } else if (verb === "on") {
      state.on = true;
      state.muted = null;
      await saveState(env, chatId, state);
      await send(env, chatId, "🔔 Rain warnings are on.");
    } else if (verb === "clothes_in") {
      state.muted = today;
      await saveState(env, chatId, state);
      await send(env, chatId, "👕 Got it – no more rain warnings today. I'll still tell you when it's dry again.");
    } else if (verb === "now") {
      await send(env, chatId, await nowMessage(env));
    } else if (verb === "status") {
      let status = state.on ? "🔔 Rain warnings are on." : "🔕 Rain warnings are off.";
      if (state.on && state.muted === today) status += " Muted for the rest of today (clothes are in).";
      await send(env, chatId, `${status}\n\n${isAdmin ? OWNER_HELP : HELP}`);
    } else if (verb === "users" && isAdmin) {
      await sendUserList(env, chatId, owner);
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

async function handleStranger(env, ownerId, owner, msg) {
  const chatId = String(msg.chat.id);
  if (owner.pending.some((u) => u.id === chatId)) {
    await send(env, chatId, "⏳ Your request is still waiting for the owner. You'll get a message here when they decide.");
    return;
  }
  const name = displayName(msg);
  const username = msg.chat.type === "private" && msg.from?.username ? ` (@${msg.from.username})` : "";
  owner.pending.push({ name, id: chatId });
  await saveState(env, ownerId, owner); // record it first, so repeat messages don't re-notify
  await send(env, ownerId, `👤 ${name}${username} wants rain alerts${msg.chat.type === "private" ? "" : " in their group"}.`, {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `approve:${chatId}` },
      { text: "❌ Decline", callback_data: `decline:${chatId}` },
    ]],
  });
  await send(env, chatId, "👋 Hi! This bot sends rain alerts for one home. I've asked the owner to give you access – you'll get a message here as soon as they decide.");
}

async function handleAdminDecision(env, ownerId, owner, verb, target, cb) {
  const pending = owner.pending.find((u) => u.id === target);
  const approved = owner.approved.find((u) => u.id === target);
  let note;
  if (verb === "approve") {
    if (!pending) {
      note = approved ? `${approved.name} already has access.` : "That request is no longer pending.";
    } else {
      owner.pending = owner.pending.filter((u) => u.id !== target);
      owner.approved.push(pending);
      await saveState(env, ownerId, owner);
      note = `✅ ${pending.name} approved. They'll get rain alerts from the next check.`;
      await send(env, target, `✅ You're in! You'll get rain alerts for home.\n\n${HELP}`).catch(() => {});
    }
  } else if (verb === "decline") {
    if (!pending) {
      note = "That request is no longer pending.";
    } else {
      owner.pending = owner.pending.filter((u) => u.id !== target);
      await saveState(env, ownerId, owner);
      note = `❌ ${pending.name} declined.`;
      await send(env, target, "Sorry, the owner didn't approve access to these rain alerts.").catch(() => {});
    }
  } else if (verb === "remove") {
    if (!approved) {
      note = "They no longer have access.";
    } else {
      owner.approved = owner.approved.filter((u) => u.id !== target);
      await saveState(env, ownerId, owner);
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

async function sendUserList(env, chatId, owner) {
  if (!owner.approved.length && !owner.pending.length) {
    await send(env, chatId, "Only you have access. When someone messages the bot, you'll get a request to approve here.");
    return;
  }
  const lines = [
    ...owner.approved.map((u) => `👤 ${u.name}`),
    ...owner.pending.map((u) => `⏳ ${u.name} (waiting for your answer above)`),
  ];
  const buttons = owner.approved.map((u) => [{ text: `🚫 Remove ${u.name}`, callback_data: `remove:${u.id}` }]);
  await send(env, chatId, `People with access besides you:\n${lines.join("\n")}`, buttons.length ? { inline_keyboard: buttons } : undefined);
}

function displayName(msg) {
  const raw = msg.chat.type === "private"
    ? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")
    : msg.chat.title;
  // Keep it to one line and free of the "–" separator used in the pinned status format.
  const name = (raw || "").replace(/[\r\n–]+/g, " ").trim().slice(0, 40);
  return name || "Someone";
}

// ------------------------------------------------------------------ state (pinned message)

export function parseState(pinned) {
  const state = { on: true, muted: null, approved: [], pending: [], msgId: null };
  const text = pinned?.text || "";
  if (!pinned?.from?.is_bot || !text.startsWith(STATUS_PREFIX)) return state;
  const lines = text.split("\n");
  state.on = !lines[0].includes("OFF");
  state.msgId = pinned.message_id;
  for (const line of lines) {
    let m;
    if ((m = line.match(/Warnings muted for today \((\d{4}-\d{2}-\d{2})\)/))) state.muted = m[1];
    else if ((m = line.match(/^👤 (.+) – (-?\d+)$/u))) state.approved.push({ name: m[1], id: m[2] });
    else if ((m = line.match(/^⏳ (.+) – (-?\d+)$/u))) state.pending.push({ name: m[1], id: m[2] });
  }
  return state;
}

export function renderState(state) {
  const lines = [`${STATUS_PREFIX} ${state.on ? "ON 🔔" : "OFF 🔕"}`];
  if (state.muted) lines.push(`👕 Warnings muted for today (${state.muted})`);
  for (const u of state.approved) lines.push(`👤 ${u.name} – ${u.id}`);
  for (const u of state.pending) lines.push(`⏳ ${u.name} – ${u.id}`);
  lines.push("Commands: /now /on /off /status");
  return lines.join("\n");
}

async function loadState(env, chatId) {
  const chat = await tg(env, "getChat", { chat_id: chatId });
  return parseState(chat.pinned_message);
}

async function saveState(env, chatId, state) {
  const text = renderState(state);
  if (state.msgId) {
    try {
      await tg(env, "editMessageText", { chat_id: chatId, message_id: state.msgId, text });
      return;
    } catch {
      // message gone or not editable: pin a new one
    }
  }
  const sent = await tg(env, "sendMessage", { chat_id: chatId, text, disable_notification: true });
  await tg(env, "pinChatMessage", { chat_id: chatId, message_id: sent.message_id, disable_notification: true });
  state.msgId = sent.message_id;
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
