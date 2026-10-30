// Runs the real background.js with fake chrome.* APIs and a fake local server
// connection, and drives the auto-reply tools exactly as Claude Desktop would.
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// background.js is an ES module; copy it to a temp .mjs so Node loads it as one.
const tmp = mkdtempSync(join(tmpdir(), "wa-bridge-bg-"));
cpSync(fileURLToPath(new URL("../extension/background.js", import.meta.url)), join(tmp, "background.mjs"));

const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("pass:", m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake chrome ----
const store = {};
const listeners = { runtime: [], storage: [], button: [] };
const notifications = new Map();
const tabMessages = [];
let tabReply = (msg) => ({ ok: true, data: { status: msg.kind === "autoSend" ? "sent" : "drafted" } });
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("no network expected"); };
globalThis.chrome = {
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      get: async (keys) => { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = structuredClone(store[k]); return o; },
      set: async (o) => { Object.assign(store, structuredClone(o)); listeners.storage.forEach((f) => f(o)); },
    },
    onChanged: { addListener: (f) => listeners.storage.push(f) },
  },
  tabs: { query: async () => [{ id: 7, windowId: 1 }], sendMessage: async (_id, msg) => { tabMessages.push(msg); return tabReply(msg); }, update: async () => {} },
  windows: { update: async () => {} },
  scripting: { insertCSS: async () => {}, executeScript: async () => {} },
  notifications: {
    create: (id, opts) => { notifications.set(id, opts); }, clear: (id) => { notifications.delete(id); },
    onClicked: { addListener() {} }, onButtonClicked: { addListener: (f) => listeners.button.push(f) },
  },
  runtime: { onMessage: { addListener: (f) => listeners.runtime.push(f) }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
};

// ---- fake local server connection ----
let sock;
const replies = new Map();
globalThis.WebSocket = class {
  constructor() { this.readyState = 0; sock = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 5); }
  send(data) {
    const m = JSON.parse(data);
    if (m.type === "hello") setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ready" }) }), 5);
    if (m.type === "res") replies.get(m.id)?.(m);
  }
  close() { this.readyState = 3; }
};
let nextId = 1;
const callTool = (tool, args = {}) => new Promise((res) => {
  const id = nextId++;
  replies.set(id, res);
  sock.onmessage({ data: JSON.stringify({ type: "req", id, tool, args }) });
});

await import(pathToFileURL(join(tmp, "background.mjs")).href);
const send = (msg) => new Promise((res) => { let answered = false; for (const f of listeners.runtime) f(msg, {}, (v) => { answered = true; res(v); }); setTimeout(() => !answered && res(undefined), 80); });

await chrome.storage.local.set({ token: "t", autoReply: true, autoReplyChats: ["Sam 🙂"], arNote: "Office: Example Tower, 5th floor", notifyMode: "name" });
await sleep(100);
assert(store.status?.status === "connected", "connected to the local server");

// 1. Queueing: only auto-reply chats, merged, nothing sent anywhere.
await send({ kind: "incoming", chat: "Random Group", incoming: ["hello"] });
await send({ kind: "incoming", chat: "Sam 🙂", incoming: ["Hi"] });
await send({ kind: "incoming", chat: "Sam 🙂", incoming: ["Where is your office?"], context: [{ from: "Sam 🙂", direction: "in", text: "Where is your office?", time: "22:40" }] });
await sleep(50);
assert(Object.keys(store.replyQueue).join() === "Sam 🙂", "only the auto-reply chat is queued");
assert(store.replyQueue["Sam 🙂"].incoming.join("|") === "Hi|Where is your office?", "burst merged into one queue entry");
assert(networkCalls === 0, "no internet/API calls at all");

// 2. Claude checks the queue.
let r = await callTool("get_pending_replies");
assert(r.ok && r.data.auto_reply_on && r.data.pending.length === 1, "get_pending_replies returns the waiting chat");
const p = r.data.pending[0];
assert(p.chat === "Sam 🙂" && p.new_messages.at(-1) === "Where is your office?" && p.recent_conversation.length === 1, "with its messages and context");
assert(r.data.user_note.includes("Example Tower"), "and the user's note");
assert(Object.keys(store.replyQueue).length === 0, "queue emptied after Claude read it");
r = await callTool("get_pending_replies");
assert(r.data.pending.length === 0, "second check: nothing new");

// 3. Claude proposes a reply → approval card, nothing sent.
r = await callTool("suggest_reply", { chat: "Sam 🙂", text: "Example Tower, 5th floor 👍", reason: "From your note" });
assert(r.ok && r.data.status === "waiting_for_user", "suggest_reply accepted");
let sugg = store.suggestions.at(-1);
assert(sugg.status === "pending" && sugg.incoming[0] === "Where is your office?", "suggestion stored with what they said");
assert(tabMessages.some((m) => m.kind === "showSuggestion" && m.suggestion.id === sugg.id), "card shown on WhatsApp");
const n = notifications.get("sugg:" + sugg.id);
assert(n && n.buttons?.length === 2 && n.message === sugg.reply, "notification with Approve/Skip");
assert(!tabMessages.some((m) => m.kind === "autoSend"), "nothing sent before approval");

// 4. Guard rails on suggest_reply.
r = await callTool("suggest_reply", { chat: "Boss", text: "ok" });
assert(!r.ok && /auto-reply list/.test(r.error), "can't suggest for a chat not on the list");

// 5. Approve from the notification.
listeners.button.forEach((f) => f("sugg:" + sugg.id, 0));
await sleep(100);
const sent = tabMessages.find((m) => m.kind === "autoSend");
assert(sent && sent.chat === "Sam 🙂" && sent.text === "Example Tower, 5th floor 👍", "approve → exact reply sent");
assert(store.suggestions.at(-1).status === "sent" && !notifications.has("sugg:" + sugg.id), "status sent, notification cleared");
r = await callTool("get_pending_replies");
assert(r.data.recent_suggestions.at(-1).outcome === "sent", "Claude can see the outcome next time");

// 6. Edited approval from the card, skip, failure, replacement.
await callTool("suggest_reply", { chat: "Sam 🙂", text: "Yes, 9 to 6" });
sugg = store.suggestions.at(-1);
let d = await send({ kind: "suggestionDecision", id: sugg.id, decision: "approve", text: "Yes, 9 to 6 Sun–Thu" });
assert(d.ok && tabMessages.filter((m) => m.kind === "autoSend").at(-1).text === "Yes, 9 to 6 Sun–Thu" && store.suggestions.at(-1).edited, "edited text is what gets sent");

await callTool("suggest_reply", { chat: "Sam 🙂", text: "Maybe" });
sugg = store.suggestions.at(-1);
const nSends = tabMessages.filter((m) => m.kind === "autoSend").length;
listeners.button.forEach((f) => f("sugg:" + sugg.id, 1));
await sleep(80);
assert(store.suggestions.at(-1).status === "skipped" && tabMessages.filter((m) => m.kind === "autoSend").length === nSends, "skip → nothing sent");

await callTool("suggest_reply", { chat: "Sam 🙂", text: "First idea" });
const first = store.suggestions.at(-1);
await callTool("suggest_reply", { chat: "Sam 🙂", text: "Better idea" });
assert(store.suggestions.find((s) => s.id === first.id).status === "replaced", "newer suggestion replaces older pending one");
sugg = store.suggestions.at(-1);
tabReply = (msg) => msg.kind === "autoSend" ? { ok: false, error: "There's already an unsent draft" } : { ok: true };
d = await send({ kind: "suggestionDecision", id: sugg.id, decision: "approve" });
assert(!d.ok && store.suggestions.at(-1).status === "pending" && tabMessages.some((m) => m.kind === "suggestionFailed"), "send failure keeps it pending and shows the error");
tabReply = () => ({ ok: true, data: {} });

// 7. Private notifications: no name, text or buttons.
await chrome.storage.local.set({ notifyMode: "private" });
await callTool("suggest_reply", { chat: "Sam 🙂", text: "Secret-ish reply" });
const pn = notifications.get("sugg:" + store.suggestions.at(-1).id);
assert(pn && !pn.buttons && !pn.message.includes("Secret-ish") && !pn.title.includes("Sam"), "private mode hides name, text and buttons");

// 8. Switched off: nothing queued, tools say so.
await chrome.storage.local.set({ autoReply: false });
await send({ kind: "incoming", chat: "Sam 🙂", incoming: ["hello?"] });
await sleep(50);
r = await callTool("get_pending_replies");
assert(r.ok && r.data.auto_reply_on === false && r.data.pending.length === 0 && Object.keys(store.replyQueue || {}).length === 0, "off: nothing queued, Claude is told");
r = await callTool("suggest_reply", { chat: "Sam 🙂", text: "x" });
assert(!r.ok && /switched off/.test(r.error), "off: suggest_reply refused");

// 9. The activity log records Claude's checks.
assert(store.log.some((e) => e.tool === "get_pending_replies" && /waiting/.test(e.result)) && store.log.some((e) => e.tool === "suggest_reply"), "checks and suggestions appear in the side panel log");
assert(networkCalls === 0, "still zero API/network calls");

console.log("ALL BACKGROUND TESTS PASSED");
process.exit(0);
