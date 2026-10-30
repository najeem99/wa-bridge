// Connects the extension to the local MCP server and routes Claude's tool calls
// to the WhatsApp tab. Every call is written to the activity log in the side panel.
// Also runs auto-reply: queues new messages for Claude and sends its replies only on approval.

const PORT = 8787;
const URL = `ws://127.0.0.1:${PORT}`;
let ws = null;
let connecting = false;
let keepAlive = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- status + activity log ----------
async function setStatus(status, detail = "") {
  await chrome.storage.local.set({ status: { status, detail, at: Date.now() } });
}

async function logActivity(entry) {
  const { log = [] } = await chrome.storage.local.get("log");
  log.push({ ...entry, at: Date.now() });
  await chrome.storage.local.set({ log: log.slice(-150) });
}

// Exactly what Claude asked for and what it was given, kept in this browser
// only so the side panel can show it. Off when "Record what was shared" is off.
const DETAIL_CAP = 20000;
function capped(value) {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && typeof value.audio_base64 === "string") {
    // Raw audio never goes in the log (and never to Claude); just note it.
    const { audio_base64, ...rest } = value;
    value = { ...rest, audio: `${Math.round((rest.bytes || 0) / 1024)} KB, sent only to the transcriber on this computer` };
  }
  const json = JSON.stringify(value);
  return json.length <= DETAIL_CAP ? value : { truncated: true, preview: json.slice(0, DETAIL_CAP) };
}
async function detailsFor(args, data) {
  const { logDetails = true } = await chrome.storage.local.get("logDetails");
  return logDetails ? { request: capped(args || {}), shared: capped(data) } : {};
}

// ---------- WebSocket to the local server ----------
async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  const { token } = await chrome.storage.local.get("token");
  if (!token) { await setStatus("needs-token", "Paste the pairing token in the side panel."); return; }

  connecting = true;
  await setStatus("connecting");
  let sock;
  try { sock = new WebSocket(URL); } catch { connecting = false; return; }
  ws = sock;

  sock.onopen = () => sock.send(JSON.stringify({ type: "hello", token }));

  sock.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "ready") {
      connecting = false;
      await setStatus("connected");
      clearInterval(keepAlive);
      // Traffic every 20s keeps the service worker (and the socket) alive.
      keepAlive = setInterval(() => sock.readyState === 1 && sock.send('{"type":"ping"}'), 20000);
      return;
    }
    if (msg.type === "pong") { pongWaiters.splice(0).forEach((f) => f(true)); return; }
    // The server reports work it did on its own (e.g. the transcript it gave Claude).
    if (msg.type === "log" && msg.entry && typeof msg.entry === "object") {
      const { tool, result, error, request, shared } = msg.entry;
      const { logDetails = true } = await chrome.storage.local.get("logDetails");
      await logActivity({ phase: error ? "error" : "done", tool: String(tool || "server"), result, error,
        ...(logDetails ? { request: capped(request), shared: capped(shared) } : {}) });
      return;
    }
    if (msg.type === "req") handleRequest(sock, msg);
  };

  sock.onclose = async (e) => {
    connecting = false;
    clearInterval(keepAlive);
    if (ws === sock) ws = null;
    if (e.code === 4003) await setStatus("bad-token", "The pairing token was rejected.");
    else await setStatus("disconnected", "Is Claude Desktop running with WA Bridge enabled?");
  };
  sock.onerror = () => {};
}

// Chrome only adds content scripts to pages loaded after the extension, so a
// WhatsApp tab opened before an extension reload has no script. When that
// happens, attach the scripts now and try once more.
const CONTENT_JS = ["content/selectors.js", "content/reader.js", "content/main.js"];
const PAGE_HOOK_JS = ["content/page-hook.js"];
const CONTENT_CSS = ["content/privacy.css"];
async function sendToTab(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(e.message)) throw e;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT_CSS });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: PAGE_HOOK_JS, world: "MAIN" }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_JS });
    } catch (inj) {
      throw new Error("Chrome won't let WA Bridge into the WhatsApp tab. In chrome://extensions → WA Bridge → Details, " +
        "set Site access to include web.whatsapp.com, then refresh WhatsApp. (" + inj.message + ")");
    }
    await new Promise((r) => setTimeout(r, 700));
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

// The side panel's refresh button: really test the link instead of trusting
// the saved status. Ping the server; if it doesn't answer, reconnect.
const pongWaiters = [];
async function checkConnection() {
  await chrome.storage.local.set({ statusCheckedAt: Date.now() });
  if (ws && ws.readyState === 1 && !connecting) {
    await setStatus("connecting", "Checking…");
    const answered = await new Promise((resolve) => {
      pongWaiters.push(resolve);
      try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch { resolve(false); }
      setTimeout(() => resolve(false), 2500);
    });
    // Servers from before this version never answer pings; an open socket still counts.
    if (answered || ws?.readyState === 1) {
      await setStatus("connected", answered ? "Checked just now" : "Connected (restart Claude Desktop once to enable full checks)");
      return { status: "connected", verified: answered };
    }
  }
  try { ws?.close(); } catch {}
  ws = null; connecting = false;
  await setStatus("connecting", "Reconnecting…");
  await connect();
  await new Promise((r) => setTimeout(r, 2500));
  const { status } = await chrome.storage.local.get("status");
  if (status?.status === "connecting") await setStatus("disconnected", "No answer from WA Bridge. Is Claude Desktop running?");
  return (await chrome.storage.local.get("status")).status;
}

async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  return tabs[0] || null;
}

async function handleRequest(sock, { id, tool, args }) {
  const reply = (body) => sock.readyState === 1 && sock.send(JSON.stringify({ type: "res", id, ...body }));
  const started = Date.now();

  if (LOCAL_TOOLS[tool]) {
    try {
      const data = await LOCAL_TOOLS[tool](args || {});
      await logActivity({ phase: "done", id, tool, ms: Date.now() - started, result: summarizeResult(tool, data), ...(await detailsFor(args, data)) });
      return reply({ ok: true, data });
    } catch (e) {
      await logActivity({ phase: "error", id, tool, error: e.message, ...(await detailsFor(args)) });
      return reply({ ok: false, error: e.message });
    }
  }

  const tab = await findWhatsAppTab();
  if (!tab) {
    const error = "WhatsApp Web is not open in Chrome. Ask the user to open web.whatsapp.com.";
    await logActivity({ phase: "error", id, tool, error });
    return reply({ ok: false, error });
  }

  try {
    const res = await sendToTab(tab, { kind: "tool", tool, args });
    if (!res) throw new Error("The WhatsApp tab didn't answer. Try reloading it.");
    await logActivity({
      phase: res.ok ? "done" : "error", id, tool,
      ms: Date.now() - started,
      error: res.ok ? undefined : res.error,
      result: res.ok ? summarizeResult(tool, res.data) : undefined,
      ...(await detailsFor(args, res.ok ? res.data : undefined)),
    });
    reply(res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error });
  } catch (e) {
    await logActivity({ phase: "error", id, tool, error: e.message, ...(await detailsFor(args)) });
    reply({ ok: false, error: e.message });
  }
}

// The log shows what Claude asked for and how much it got back, not the message text itself.
function summarizeArgs(tool, a = {}) {
  if (tool === "draft_reply" || tool === "send_message" || tool === "suggest_reply") return { chat: a.chat, text_length: (a.text || "").length };
  return a;
}
function summarizeResult(tool, d = {}) {
  switch (tool) {
    case "list_chats": return `${d.chats?.length ?? 0} chats`;
    case "get_messages": return `${d.messages?.length ?? 0} messages from "${d.chat}"`;
    case "get_new_messages": return `${d.events?.length ?? 0} new in allowed chats, ${d.other_chats_with_activity ?? 0} other chats hidden`;
    case "find_contact": return `${d.results?.length ?? 0} matches`;
    case "draft_reply": return `draft typed in "${d.chat}" (not sent)`;
    case "get_pending_replies": return d.auto_reply_on ? `${d.pending?.length ?? 0} ${(d.pending?.length ?? 0) === 1 ? "chat" : "chats"} waiting for a reply` : "auto-reply is off";
    case "suggest_reply": return `suggested a reply for "${d.chat}" (waiting for you)`;
    case "inspect_layout": return "page structure only (no messages or names)";
    case "get_voice_audio": return `voice note from "${d.from}" (${d.duration || "?"}) passed to the transcriber on this computer, not to Claude`;
    case "send_message": return {
      sent: `sent to "${d.chat}" ${/automatically/.test(d.how || "") ? "after the countdown" : "after you clicked Send"}${d.edited_by_user ? " (you edited it)" : ""}`,
      cancelled: `you cancelled a message to "${d.chat}"`,
      kept_as_draft: `you kept a message to "${d.chat}" as a draft`,
      timed_out: `no answer; message to "${d.chat}" left as draft`,
    }[d.status] || `not sent to "${d.chat}"`;
    default: return "ok";
  }
}

// ---------- private notifications ----------
async function notify({ chat, allowed, preview }) {
  const { notifyMode = "private" } = await chrome.storage.local.get("notifyMode");
  if (notifyMode === "off") return;
  let title = "New WhatsApp message";
  let message = "Open WhatsApp to read it.";
  if (notifyMode === "name" || notifyMode === "preview") title = `New message from ${chat}`;
  if (notifyMode === "preview" && allowed && preview) message = preview;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title,
    message,
    silent: false,
  });
}

// Claude is waiting for you to confirm a send. Always notify (even in "off"
// mode), because the request times out if you don't see it.
const CONFIRM_NOTE_ID = "wa-bridge-confirm";
async function notifyConfirm({ chat, mode, delaySec = 5 }) {
  const { notifyMode = "private" } = await chrome.storage.local.get("notifyMode");
  const to = notifyMode === "private" ? "" : `To ${chat}. `;
  const countdown = mode === "countdown";
  chrome.notifications.create(CONFIRM_NOTE_ID, {
    type: "basic",
    iconUrl: "icon.png",
    title: countdown ? `Sending a WhatsApp message in ${delaySec}s` : "Claude wants to send a WhatsApp message",
    message: countdown ? `${to}Click to open WhatsApp if you want to cancel.` : `${to}Open WhatsApp to review and confirm.`,
    requireInteraction: !countdown,
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener(async () => {
  const tab = await findWhatsAppTab();
  if (tab) { chrome.tabs.update(tab.id, { active: true }); chrome.windows.update(tab.windowId, { focused: true }); }
});

// ---------- auto-reply (powered by Claude Desktop / your Pro plan) ----------
// The extension never calls an AI itself. It queues new messages from your
// auto-reply chats; Claude picks them up with get_pending_replies and proposes
// replies with suggest_reply, which show up here as approval cards.
const SUGGESTION_TTL_MS = 30 * 60 * 1000;
const QUEUE_TTL_MS = 2 * 60 * 60 * 1000; // drop unanswered queue items after 2 hours

async function arSettings() {
  const s = await chrome.storage.local.get(["autoReply", "autoReplyChats", "arNote", "notifyMode"]);
  return { on: !!s.autoReply, chats: s.autoReplyChats || [], note: s.arNote || "", notifyMode: s.notifyMode || "private" };
}
const inList = (list, name) => list.some((a) => a.trim().toLowerCase() === (name || "").trim().toLowerCase());

async function getSuggestions() {
  const { suggestions = [] } = await chrome.storage.local.get("suggestions");
  const now = Date.now();
  return suggestions.map((s) => (s.status === "pending" && now - s.at > SUGGESTION_TTL_MS ? { ...s, status: "expired" } : s));
}
async function putSuggestion(sug) {
  const list = (await getSuggestions()).filter((s) => s.id !== sug.id);
  list.push(sug);
  await chrome.storage.local.set({ suggestions: list.slice(-30) });
}
async function patchSuggestion(id, patch) {
  const list = await getSuggestions();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  await chrome.storage.local.set({ suggestions: list });
  return list[i];
}

// queue: { [chat]: { incoming: [text], context: [msg], first_at, last_at } }
async function getQueue() {
  const { replyQueue = {} } = await chrome.storage.local.get("replyQueue");
  const now = Date.now();
  for (const [chat, q] of Object.entries(replyQueue)) if (now - q.last_at > QUEUE_TTL_MS) delete replyQueue[chat];
  return replyQueue;
}

async function onIncoming({ chat, incoming = [], context = [] }) {
  const st = await arSettings();
  if (!st.on || !inList(st.chats, chat)) return;
  const queue = await getQueue();
  const q = queue[chat] || { incoming: [], context: [], first_at: Date.now() };
  q.incoming = [...q.incoming, ...incoming].slice(-8);
  if (context.length) q.context = context.slice(-12); // newest full context wins
  q.last_at = Date.now();
  queue[chat] = q;
  const { lastIncoming = {} } = await chrome.storage.local.get("lastIncoming");
  if (incoming.length) lastIncoming[chat] = String(incoming[incoming.length - 1]).slice(0, 300);
  await chrome.storage.local.set({ replyQueue: queue, lastIncoming });
}

// Tool: get_pending_replies — hands the queue to Claude and empties it.
async function toolGetPendingReplies() {
  const st = await arSettings();
  if (!st.on) return { auto_reply_on: false, pending: [], note: "Auto-reply is switched off in the WA Bridge side panel." };
  const queue = await getQueue();
  await chrome.storage.local.set({ replyQueue: {} });
  const pending = Object.entries(queue)
    .filter(([chat]) => inList(st.chats, chat))
    .map(([chat, q]) => ({
      chat,
      new_messages: q.incoming,
      recent_conversation: q.context.length ? q.context : undefined,
      context_note: q.context.length ? undefined : "Only the sidebar preview is available (chat wasn't open).",
      waiting_since: new Date(q.first_at).toLocaleTimeString(),
    }));
  const recent = (await getSuggestions()).slice(-5).map((s) => ({ chat: s.chat, reply: s.reply, outcome: s.status }));
  return {
    auto_reply_on: true,
    user_note: st.note || "(The user hasn't written a note. Only answer from the conversation itself, or pleasantries.)",
    pending,
    recent_suggestions: recent,
  };
}

// Tool: suggest_reply — shows Claude's proposed reply as an approval card.
async function toolSuggestReply({ chat, text, reason = "" }) {
  const st = await arSettings();
  if (!st.on) throw new Error("Auto-reply is switched off in the WA Bridge side panel.");
  if (!inList(st.chats, chat)) throw new Error(`"${chat}" is not on the auto-reply list.`);
  const reply = String(text || "").trim();
  if (!reply) throw new Error("Empty reply.");

  // A newer suggestion for the same chat replaces any older pending one.
  for (const old of (await getSuggestions()).filter((s) => s.chat === chat && s.status === "pending")) {
    await patchSuggestion(old.id, { status: "replaced" });
    chrome.notifications.clear("sugg:" + old.id);
  }
  const { lastIncoming = {} } = await chrome.storage.local.get("lastIncoming");
  const sug = {
    id: Math.random().toString(36).slice(2, 10), chat, at: Date.now(), status: "pending",
    incoming: lastIncoming[chat] ? [lastIncoming[chat]] : [], reply: reply.slice(0, 4000), reason: String(reason).slice(0, 300),
  };
  await putSuggestion(sug);

  const tab = await findWhatsAppTab();
  if (tab) sendToTab(tab, { kind: "showSuggestion", suggestion: sug }).catch(() => {});
  const privateMode = st.notifyMode === "private";
  chrome.notifications.create("sugg:" + sug.id, {
    type: "basic", iconUrl: "icon.png", priority: 2, requireInteraction: !privateMode,
    title: privateMode ? "Suggested WhatsApp reply ready" : `Reply to ${chat}?`,
    message: privateMode ? "Open WhatsApp to review it." : sug.reply,
    ...(privateMode ? {} : { buttons: [{ title: "Approve & send" }, { title: "Skip" }] }),
  });
  return { shown: true, chat, status: "waiting_for_user", note: "Shown as an approval card on WhatsApp. The user decides; nothing is sent until they approve." };
}

const LOCAL_TOOLS = { get_pending_replies: toolGetPendingReplies, suggest_reply: toolSuggestReply };

async function decide(id, decision, editedText) {
  const sug = (await getSuggestions()).find((s) => s.id === id);
  if (!sug || sug.status !== "pending") return { ok: false, error: "This suggestion is no longer pending." };
  const tab = await findWhatsAppTab();
  const finish = async (status, extra = {}) => {
    await patchSuggestion(id, { status, ...extra });
    chrome.notifications.clear("sugg:" + id);
    if (tab) sendToTab(tab, { kind: "hideSuggestion", id }).catch(() => {});
  };

  if (decision === "skip") {
    await finish("skipped");
    await logActivity({ phase: "done", tool: "auto-reply", result: `you skipped the reply for "${sug.chat}"` });
    return { ok: true };
  }

  const text = (editedText ?? sug.reply).trim();
  if (!text) return { ok: false, error: "The reply is empty." };
  const fail = async (error) => {
    if (tab) sendToTab(tab, { kind: "suggestionFailed", id, error }).catch(() => {});
    chrome.notifications.create("sugg-err:" + id, { type: "basic", iconUrl: "icon.png", title: "Reply not sent", message: error });
    await logActivity({ phase: "error", tool: "auto-reply", error: `"${sug.chat}": ${error}` });
    return { ok: false, error };
  };
  if (!tab) return fail("WhatsApp Web isn't open.");
  try {
    const res = await sendToTab(tab, { kind: decision === "approve" ? "autoSend" : "autoDraft", chat: sug.chat, text });
    if (!res?.ok) return fail(res?.error || "No answer from the WhatsApp tab.");
    const status = decision === "approve" ? "sent" : "drafted";
    await finish(status, { reply: text, edited: text !== sug.reply });
    await logActivity({
      phase: "done", tool: "auto-reply",
      result: status === "sent" ? `sent approved reply to "${sug.chat}"${text !== sug.reply ? " (you edited it)" : ""}` : `put reply in "${sug.chat}" box`,
    });
    return { ok: true };
  } catch (e) {
    return fail(e.message);
  }
}

chrome.notifications.onButtonClicked.addListener((notifId, index) => {
  if (notifId.startsWith("sugg:")) decide(notifId.slice(5), index === 0 ? "approve" : "skip");
});

// ---------- wiring ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.kind === "incoming") onIncoming(msg);
  if (msg.kind === "checkConnection") { checkConnection().then(sendResponse); return true; }
  if (msg.kind === "suggestionDecision") {
    decide(msg.id, msg.decision, msg.text).then(sendResponse);
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === "notify") notify(msg);
  if (msg.kind === "confirmPending") notifyConfirm(msg);
  if (msg.kind === "confirmDone") chrome.notifications.clear(CONFIRM_NOTE_ID);
  if (msg.kind === "waReady" || msg.kind === "reconnect") connect();
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === "panic-blur") {
    const { blur = false } = await chrome.storage.local.get("blur");
    chrome.storage.local.set({ blur: !blur });
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.token) { try { ws?.close(); } catch {} ws = null; connect(); }
});

chrome.alarms.create("wa-bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "wa-bridge-reconnect" && connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// A fresh start means nothing is connected yet, whatever was saved last time.
// (Otherwise a green dot from an old session could stay green.)
setStatus("connecting", "Checking…").then(connect);
