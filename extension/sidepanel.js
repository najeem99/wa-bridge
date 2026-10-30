const $ = (id) => document.getElementById(id);
const STATUS_TEXT = {
  connected: "Connected to Claude Desktop",
  connecting: "Connecting…",
  disconnected: "Not connected",
  "bad-token": "Token rejected",
  "needs-token": "Needs pairing token",
};

async function render() {
  const s = await chrome.storage.local.get(["status", "token", "logDetails", "blur", "notifyMode", "allowlist", "allowAll", "allowSend", "sendMode", "log"]);
  $("allowSend").checked = s.allowSend !== false;
  $("sendMode").value = s.sendMode === "confirm" ? "confirm" : "countdown";
  $("sendMode").disabled = s.allowSend === false;

  const st = s.status?.status || "disconnected";
  $("dot").className = "dot " + st;
  $("statusText").textContent = STATUS_TEXT[st] || st;
  $("statusText").title = s.status?.detail || "";
  $("statusDetail").textContent = s.status?.detail || "";
  $("logDetails").checked = s.logDetails !== false;
  $("pairing").hidden = st === "connected" && !!s.token;

  $("blur").checked = !!s.blur;
  $("notifyMode").value = s.notifyMode || "private";
  $("allowAll").checked = !!s.allowAll;
  $("allowAllWarn").hidden = !s.allowAll;

  const chips = $("chips");
  chips.replaceChildren();
  const list = s.allowlist || [];
  if (!list.length) chips.innerHTML = '<span class="empty">No chats allowed yet.</span>';
  for (const name of list) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => chrome.storage.local.set({ allowlist: list.filter((n) => n !== name) });
    chip.appendChild(x);
    chips.appendChild(chip);
  }

  const log = $("log");
  const entries = (s.log || []).filter((e) => e.phase !== "start").slice().reverse();
  log.replaceChildren();
  if (!entries.length) log.innerHTML = '<li class="empty">Nothing yet.</li>';
  for (const e of entries) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date(e.at).toLocaleTimeString();
    const tool = document.createElement("span");
    tool.className = "tool";
    tool.textContent = e.tool;
    const detail = document.createElement("div");
    detail.className = e.phase === "error" ? "err" : "res";
    detail.textContent = e.phase === "error" ? e.error : e.result;
    li.append(t, tool, detail);
    const more = sharedDetails(e);
    if (more) li.appendChild(more);
    log.appendChild(li);
  }
}

// ---------- "what was shared" details for a log entry ----------
const openEntries = new Set(); // keeps expanded entries open across re-renders
const mk = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
function section(title, items) {
  if (!items.length) return null;
  const box = mk("div");
  box.append(mk("h4", null, title));
  const ul = mk("ul");
  for (const it of items) ul.appendChild(it);
  box.appendChild(ul);
  return box;
}
function msgItem(m) {
  const li = mk("li", "msg");
  li.append(mk("span", "who", (m.from || m.chat || "") + " "), mk("span", "when", [m.time, m.date].filter(Boolean).join(", ")));
  li.append(mk("div", null, m.text ?? m.preview ?? ""));
  return li;
}
function sharedDetails(e) {
  if (!e.request && !e.shared) return null;
  const d = e.shared || {};
  const req = e.request || {};
  const parts = [];

  // What Claude asked for (including any text it wanted to send).
  const asked = Object.entries(req).filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => mk("li", null, `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`));
  parts.push(section("Claude asked", asked));

  if (d.truncated) { parts.push(section("Shared (too long to show in full)", [mk("li", null, d.preview.slice(0, 2000) + "…")])); }
  else {
    // Contacts / chat names
    const names = [
      ...(d.chats || []).map((c) => c.name + (c.unread ? ` (${c.unread} unread)` : "") + (c.preview ? ` · “${c.preview}”` : "")),
      ...(d.results || []).map((c) => c.name),
      ...(d.pending || []).map((p) => p.chat),
    ];
    if (d.chat && !names.length) names.push(d.chat);
    parts.push(section(`Contacts / chats shared (${names.length})`, names.map((n) => mk("li", null, n))));

    // Messages
    const msgs = [
      ...(d.messages || []),
      ...(d.events || []).map((ev) => ({ chat: ev.chat, time: ev.time, preview: ev.preview })),
      ...(d.pending || []).flatMap((p) => (p.recent_conversation?.length ? p.recent_conversation : (p.new_messages || []).map((t) => ({ from: p.chat, text: t })))),
    ];
    if (d.replying_to) msgs.push({ from: "Replying to " + d.replying_to.from, time: d.replying_to.time, text: d.replying_to.text });
    if (d.text && e.tool === "send_message") msgs.push({ from: "Sent by Claude", text: d.text });
    parts.push(section(`Messages shared (${msgs.length})`, msgs.map(msgItem)));

    if (d.user_note) parts.push(section("Your auto-reply note", [mk("li", "msg", d.user_note)]));
    if (d.other_chats_with_activity) parts.push(section("Hidden", [mk("li", null, `${d.other_chats_with_activity} other chats had activity (not named)`)]));
  }
  const raw = mk("details");
  raw.append(mk("summary", null, "Raw data"), mk("pre", null, JSON.stringify({ request: req, shared: e.shared }, null, 2)));
  parts.push(raw);

  const key = `${e.at}-${e.tool}`;
  const wrap = mk("details");
  wrap.open = openEntries.has(key);
  wrap.addEventListener("toggle", () => { wrap.open ? openEntries.add(key) : openEntries.delete(key); });
  wrap.append(mk("summary", null, "Show what Claude received"));
  const inner = mk("div", "shared");
  for (const p of parts) if (p) inner.appendChild(p);
  wrap.appendChild(inner);
  return wrap;
}

$("logDetails").onchange = (e) => chrome.storage.local.set({ logDetails: e.target.checked });
$("refreshBtn").onclick = async () => {
  const b = $("refreshBtn");
  b.classList.add("spin"); b.disabled = true;
  $("dot").className = "dot connecting";
  $("statusText").textContent = "Checking…";
  try { await chrome.runtime.sendMessage({ kind: "checkConnection" }); } catch {}
  b.classList.remove("spin"); b.disabled = false;
  render();
};

async function loadSuggestions() {
  const [tab] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (!tab) return;
  try {
    const names = await chrome.tabs.sendMessage(tab.id, { kind: "chatNames" });
    const dl = $("chatNames");
    dl.replaceChildren(...(names || []).map((n) => Object.assign(document.createElement("option"), { value: n })));
  } catch {}
}

$("saveToken").onclick = async () => {
  const token = $("token").value.trim();
  if (token) await chrome.storage.local.set({ token });
  $("token").value = "";
  chrome.runtime.sendMessage({ kind: "reconnect" });
};
$("blur").onchange = (e) => chrome.storage.local.set({ blur: e.target.checked });
$("notifyMode").onchange = (e) => chrome.storage.local.set({ notifyMode: e.target.value });
$("allowAll").onchange = (e) => chrome.storage.local.set({ allowAll: e.target.checked });
$("allowSend").onchange = (e) => chrome.storage.local.set({ allowSend: e.target.checked });
$("sendMode").onchange = (e) => chrome.storage.local.set({ sendMode: e.target.value });
$("clearLog").onclick = () => chrome.storage.local.set({ log: [] });

async function addName() {
  const name = $("addName").value.trim();
  if (!name) return;
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  if (!allowlist.some((n) => n.toLowerCase() === name.toLowerCase())) allowlist.push(name);
  await chrome.storage.local.set({ allowlist });
  $("addName").value = "";
}
$("addBtn").onclick = addName;
$("addName").onkeydown = (e) => e.key === "Enter" && addName();
$("addName").onfocus = loadSuggestions;

// ---------- auto-reply ----------
function chipList(container, list, key) {
  container.replaceChildren();
  if (!list.length) { container.innerHTML = '<span class="empty">None yet.</span>'; return; }
  for (const name of list) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name;
    const x = Object.assign(document.createElement("button"), { textContent: "×", title: "Remove" });
    x.onclick = () => chrome.storage.local.set({ [key]: list.filter((n) => n !== name) });
    chip.appendChild(x);
    container.appendChild(chip);
  }
}

async function renderAutoReply() {
  const s = await chrome.storage.local.get(["autoReply", "arNote", "autoReplyChats", "suggestions", "replyQueue"]);
  $("autoReply").checked = !!s.autoReply;
  $("arBody").style.opacity = s.autoReply ? "1" : "0.55";
  const queued = Object.keys(s.replyQueue || {});
  $("queueInfo").textContent = queued.length
    ? `Waiting for Claude to check: ${queued.join(", ")}`
    : "No new messages waiting for Claude.";
  if (document.activeElement !== $("arNote")) $("arNote").value = s.arNote || "";
  chipList($("arChips"), s.autoReplyChats || [], "autoReplyChats");

  const list = $("suggList");
  list.replaceChildren();
  const pending = (s.suggestions || []).filter((x) => x.status === "pending" && Date.now() - x.at < 30 * 60 * 1000).reverse();
  if (!pending.length) { list.innerHTML = '<li class="empty">Nothing waiting.</li>'; return; }
  for (const sug of pending) {
    const li = document.createElement("li");
    li.style.cssText = "border-top:1px solid var(--line);padding:8px 0";
    const head = Object.assign(document.createElement("div"), { className: "tool", textContent: sug.chat });
    const said = Object.assign(document.createElement("div"), { className: "res", textContent: "“" + (sug.incoming?.at(-1) || "") + "”" });
    const reply = Object.assign(document.createElement("div"), { textContent: sug.reply });
    reply.style.cssText = "margin:4px 0;padding:6px 8px;border-radius:8px;background:var(--chip)";
    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.style.justifyContent = "flex-end";
    const mk = (t, cls, d) => {
      const b = Object.assign(document.createElement("button"), { textContent: t, className: cls });
      b.onclick = async () => {
        row.querySelectorAll("button").forEach((x) => (x.disabled = true));
        const res = await chrome.runtime.sendMessage({ kind: "suggestionDecision", id: sug.id, decision: d });
        if (res && !res.ok) { reply.insertAdjacentHTML("afterend", '<div class="err"></div>'); reply.nextSibling.textContent = res.error; row.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
      };
      return b;
    };
    row.append(mk("Skip", "", "skip"), mk("Put in box", "", "draft"), mk("Approve & send", "primary", "approve"));
    li.append(head, said, reply, row);
    list.appendChild(li);
  }
}

$("autoReply").onchange = (e) => chrome.storage.local.set({ autoReply: e.target.checked });
let noteTimer;
$("arNote").oninput = (e) => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => { await chrome.storage.local.set({ arNote: e.target.value }); $("noteSaved").textContent = "Saved."; }, 600);
};
async function addAutoChat() {
  const name = $("arAddName").value.trim();
  if (!name) return;
  const { autoReplyChats = [] } = await chrome.storage.local.get("autoReplyChats");
  if (!autoReplyChats.some((n) => n.toLowerCase() === name.toLowerCase())) autoReplyChats.push(name);
  await chrome.storage.local.set({ autoReplyChats });
  $("arAddName").value = "";
}
$("arAddBtn").onclick = addAutoChat;
$("arAddName").onkeydown = (e) => e.key === "Enter" && addAutoChat();
$("arAddName").onfocus = loadSuggestions;

chrome.storage.onChanged.addListener(render);
chrome.storage.onChanged.addListener(renderAutoReply);
render();
renderAutoReply();
loadSuggestions();
