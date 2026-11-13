// Offline tests for worker/src/index.js with fake Telegram, KV, GitHub and Open-Meteo.
// Run from the repository root:  node --test tests/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { startCheck } from "../worker/src/index.js";

const OWNER = "111", ANA = "222", EVE = "999";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Montevideo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---- fakes
let kv, tgState, env, logs;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeKV(initial) {
  const store = new Map(initial ? [["state", JSON.stringify(initial)]] : []);
  return {
    store, failGet: false, puts: 0,
    async get(k) { if (this.failGet) throw new Error("kv down"); return store.get(k) ?? null; },
    async put(k, v) { this.puts++; store.set(k, v); },
    doc() { return JSON.parse(store.get("state")); },
  };
}

beforeEach(() => {
  kv = makeKV({ version: 1, chats: {}, approved: [], pending: [] });
  tgState = { sent: [], edits: [], calls: [], pinned: {}, forecast: null, github: [] };
  env = { BOT_TOKEN: "FAKE-BOT", ADMIN_CHAT_IDS: OWNER, WEBHOOK_SECRET: "hook", STATE_SECRET: "s3cret",
    GITHUB_TOKEN: "FAKE-GH", GITHUB_REPO: "o/r", RAIN_MM_THRESHOLD: "0.2", RAIN_PROB_THRESHOLD: "40", STATE: kv };
  logs = [];
  globalThis.setTimeout = (f) => f(); // skip retry waits
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith("https://api.open-meteo.com/")) return tgState.forecast ? json(200, tgState.forecast) : json(500, {});
    if (url.startsWith("https://api.github.com/")) {
      tgState.github.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) });
      return new Response(null, { status: tgState.githubStatus?.shift() ?? 204 });
    }
    const method = url.split("/").pop();
    const p = JSON.parse(opts.body || "{}");
    tgState.calls.push(method);
    if (method === "getChat") return json(200, { ok: true, result: { pinned_message: tgState.pinned[String(p.chat_id)] } });
    if (method === "sendMessage") {
      tgState.sent.push({ chat: String(p.chat_id), text: p.text, markup: p.reply_markup });
      return json(200, { ok: true, result: { message_id: tgState.sent.length } });
    }
    if (method === "editMessageText") { tgState.edits.push(p); return json(200, { ok: true, result: {} }); }
    if (method === "answerCallbackQuery") return json(200, { ok: true, result: true });
    throw new Error(`unexpected Telegram call ${method}`);
  };
  console.log = (...a) => logs.push(a.join(" "));
});

let uid = 1;
const post = (update, secret = "hook") => worker.fetch(new Request("https://w.example/", {
  method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: uid++, ...update }),
}), env);
const say = (chat, text, first = "Ana", type = "private") => post({ message: {
  chat: { id: Number(chat), type, title: type === "private" ? undefined : "Family" }, from: { first_name: first, username: first.toLowerCase() }, text } });
const tap = (chat, data, messageId = 1) => post({ callback_query: { id: `cb${uid}`, data, from: { id: Number(chat) },
  message: { message_id: messageId, chat: { id: Number(chat), type: "private" } } } });
const api = (path, { method = "GET", auth = "Bearer s3cret", body } = {}) => worker.fetch(new Request(`https://w.example${path}`, {
  method, headers: auth ? { authorization: auth } : {}, body: body && JSON.stringify(body) }), env);
const to = (chat) => tgState.sent.filter((s) => s.chat === chat);
const clear = () => { tgState.sent = []; tgState.edits = []; tgState.calls = []; };

async function approveAna() {
  await say(ANA, "hi");
  await tap(OWNER, `approve:${ANA}`, 50);
  clear();
}

// ---- webhook security
test("requests without the webhook secret are refused", async () => {
  const r = await post({ message: { chat: { id: 1, type: "private" }, text: "/off" } }, "wrong");
  assert.equal(r.status, 403);
  assert.equal(tgState.calls.length, 0);
  assert.equal(kv.puts, 0);
});

// ---- access requests
test("stranger -> owner gets Approve/Decline; repeat messages don't re-notify", async () => {
  await say(ANA, "hi");
  const req = to(OWNER).find((s) => s.markup);
  assert.match(req.text, /Ana \(@ana\) wants rain alerts/);
  assert.deepEqual(req.markup.inline_keyboard[0].map((b) => b.callback_data), [`approve:${ANA}`, `decline:${ANA}`]);
  assert.deepEqual(kv.doc().pending, [{ name: "Ana", id: ANA }]);
  clear();
  await say(ANA, "hello?");
  assert.equal(to(OWNER).length, 0);
  assert.match(to(ANA)[0].text, /still waiting/);
});

test("approve -> stored permanently, request message replaced, person welcomed", async () => {
  await say(ANA, "hi");
  clear();
  await tap(OWNER, `approve:${ANA}`, 50);
  assert.deepEqual(kv.doc().approved, [{ name: "Ana", id: ANA }]);
  assert.deepEqual(kv.doc().pending, []);
  assert.ok(tgState.edits.some((e) => e.message_id === 50 && /Ana approved/.test(e.text)));
  assert.match(to(ANA)[0].text, /You're in/);
});

test("strangers and approved non-owners can't approve or remove", async () => {
  await approveAna();
  await say(EVE, "hi", "Eve");
  await tap(EVE, `approve:${EVE}`);
  await tap(ANA, `approve:${EVE}`);
  await tap(ANA, `remove:${ANA}`);
  assert.deepEqual(kv.doc().approved.map((u) => u.id), [ANA]);
  assert.deepEqual(kv.doc().pending.map((u) => u.id), [EVE]);
});

test("decline and remove", async () => {
  await approveAna();
  await say(EVE, "hi", "Eve");
  await tap(OWNER, `decline:${EVE}`, 77);
  assert.deepEqual(kv.doc().pending, []);
  await tap(OWNER, `remove:${ANA}`);
  assert.deepEqual(kv.doc().approved, []);
  assert.ok(to(ANA).some((s) => /removed/.test(s.text)));
});

// ---- the bug from 6 Nov: access must never vanish by accident
test("a change that would drop an approved person is refused and the owner is told", async () => {
  await approveAna();
  const good = kv.store.get("state");
  // Simulate a buggy code path that loses the list while saving something unrelated.
  const { saveSettings, loadSettings } = await import("../worker/src/index.js");
  const before = await loadSettings(env);
  const broken = { ...structuredClone(before), approved: [] };
  await assert.rejects(saveSettings(env, before, broken));
  assert.equal(kv.store.get("state"), good);
  assert.ok(to(OWNER).some((s) => /blocked a change that would have removed access for Ana/.test(s.text)));
});

test("settings unavailable -> nothing written, user told", async () => {
  await approveAna();
  const putsBefore = kv.puts;
  kv.failGet = true;
  await say(OWNER, "/off", "Owner");
  assert.equal(kv.puts, putsBefore);
  assert.match(to(OWNER)[0].text, /settings are temporarily unavailable/);
  kv.failGet = false;
  assert.deepEqual(kv.doc().approved.map((u) => u.id), [ANA]);
});

test("pinned messages are irrelevant once migrated (unpinning or new pins can't lose access)", async () => {
  await approveAna();
  tgState.pinned[OWNER] = { message_id: 9, from: { is_bot: false }, text: "some other pinned message" };
  await say(OWNER, "/off", "Owner");
  await tap(OWNER, "clothes_in");
  await say(EVE, "hi", "Eve");
  assert.deepEqual(kv.doc().approved.map((u) => u.id), [ANA]);
  assert.ok(!tgState.calls.includes("getChat"));
});

test("every save keeps the previous version", async () => {
  await approveAna();
  await say(OWNER, "/off", "Owner");
  const prev = JSON.parse(kv.store.get("state:prev"));
  assert.equal(prev.chats[OWNER]?.on ?? true, true);
  assert.equal(kv.doc().chats[OWNER].on, false);
});

// ---- migration from the old pinned format
test("first run copies settings from the old pinned status message", async () => {
  kv = makeKV(null);
  env.STATE = kv;
  tgState.pinned[OWNER] = { message_id: 5, from: { is_bot: true },
    text: `📌 Rain alert status: OFF 🔕\n👤 Ana – ${ANA}\n⏳ Eve – ${EVE}\nCommands: /now /on /off /status` };
  tgState.pinned[ANA] = { message_id: 6, from: { is_bot: true }, text: `📌 Rain alert status: ON 🔔\n👕 Warnings muted for today (${today})\nCommands: /now /on /off /status` };
  await say(OWNER, "/status", "Owner");
  const doc = kv.doc();
  assert.deepEqual(doc.approved, [{ name: "Ana", id: ANA }]);
  assert.deepEqual(doc.pending, [{ name: "Eve", id: EVE }]);
  assert.equal(doc.chats[OWNER].on, false);
  assert.equal(doc.chats[ANA].muted, today);
  assert.ok(to(OWNER).some((s) => /permanent storage.*1 approved, 1 waiting/.test(s.text)));
});

test("first run with no readable pinned message starts with only the owner, and says so", async () => {
  kv = makeKV(null);
  env.STATE = kv;
  await say(OWNER, "/status", "Owner");
  assert.deepEqual(kv.doc().approved, []);
  assert.ok(to(OWNER).some((s) => /permanent storage/.test(s.text)));
});

// ---- per-chat settings
test("on / off / clothes in are per chat", async () => {
  await approveAna();
  await say(ANA, "/off");
  await tap(OWNER, "clothes_in");
  const doc = kv.doc();
  assert.equal(doc.chats[ANA].on, false);
  assert.equal(doc.chats[OWNER].muted, today);
  assert.equal(doc.chats[OWNER].on, true);
  await say(ANA, "/on");
  assert.deepEqual(kv.doc().chats[ANA], { on: true, muted: null });
});

test("/users is owner-only and lists Remove buttons", async () => {
  await approveAna();
  await say(ANA, "/users");
  assert.equal(to(ANA).length, 0);
  await say(OWNER, "/users", "Owner");
  assert.equal(to(OWNER)[0].markup.inline_keyboard[0][0].callback_data, `remove:${ANA}`);
});

// ---- API used by the GitHub job
test("API needs the shared secret", async () => {
  assert.equal((await api("/api/recipients", { auth: null })).status, 403);
  assert.equal((await api("/api/recipients", { auth: "Bearer wrong" })).status, 403);
});

test("API lists owner + approved with their settings; expired mutes are dropped", async () => {
  await approveAna();
  const doc = kv.doc();
  doc.chats[ANA] = { on: false, muted: null };
  doc.chats[OWNER] = { on: true, muted: "2000-01-01" };
  kv.store.set("state", JSON.stringify(doc));
  const body = await (await api("/api/recipients")).json();
  assert.deepEqual(body.chats, [{ id: OWNER, on: true, muted: null }, { id: ANA, on: false, muted: null }]);
});

test("API unmute clears only the mute", async () => {
  await approveAna();
  await tap(ANA, "clothes_in");
  const r = await api("/api/unmute", { method: "POST", body: { chat_id: ANA } });
  assert.equal(r.status, 200);
  assert.deepEqual(kv.doc().chats[ANA], { on: true, muted: null });
  assert.deepEqual(kv.doc().approved.map((u) => u.id), [ANA]);
});

test("API reports 503 when settings are unavailable", async () => {
  kv.failGet = true;
  assert.equal((await api("/api/recipients")).status, 503);
});

// ---- /now
test("/now: forecast down or incomplete is said plainly, never 'no rain'", async () => {
  await say(OWNER, "/now", "Owner");
  assert.match(to(OWNER)[0].text, /isn't answering/);
});

// ---- schedule
test("schedule: slots map to modes and pass the time slot", async () => {
  for (const [cron, mode] of [["7 10 * * *", "daily"], ["7 23 * * *", "evening"], ["7 11-22 * * *", "hourly"]]) {
    tgState.github = [];
    await startCheck({ cron, scheduledTime: Date.UTC(2026, 10, 13, 10, 7) }, env);
    assert.equal(tgState.github[0].body.inputs.mode, mode);
    assert.equal(tgState.github[0].body.inputs.scheduled_at, "2026-11-13T10:07:00.000Z");
    assert.equal(tgState.github[0].auth, "Bearer FAKE-GH");
  }
});

test("schedule: expired token -> owner told once (07:07 only), tokens never logged", async () => {
  tgState.githubStatus = [401];
  await startCheck({ cron: "7 10 * * *", scheduledTime: Date.now() }, env);
  assert.ok(to(OWNER).some((s) => /may have expired/.test(s.text)));
  clear();
  tgState.githubStatus = [401];
  await startCheck({ cron: "7 12 * * *", scheduledTime: Date.now() }, env);
  assert.equal(to(OWNER).length, 0);
  assert.ok(!logs.join("\n").includes("FAKE"));
});
