// Renders WA Bridge's real UI (content scripts + side panel) on a demo chat page
// with made-up contacts, and saves README screenshots.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const REPO = process.argv[2] || path.join(__dirname, "..");
const OUT = process.argv[3] || path.join(REPO, "docs", "screenshots");
const ext = (f) => fs.readFileSync(path.join(REPO, "extension", f), "utf8");

const now = Date.now();
const store = {
  status: { status: "connected", at: now },
  token: "demo",
  blur: false,
  notifyMode: "private",
  allowlist: ["Ahmed (Team Lead)", "Family"],
  allowAll: false,
  allowSend: true,
  sendMode: "countdown",
  autoReply: true,
  arNote: "Office: Example Tower, 5th floor. Hours 9–6, Mon–Fri.\nIf someone asks me to call: say I'll call back after 7pm.\nNever agree to plans, meetings or payments.",
  autoReplyChats: ["Ahmed (Team Lead)"],
  replyQueue: {},
  suggestions: [{ id: "s1", chat: "Ahmed (Team Lead)", at: now, status: "pending", incoming: ["Where's the office again?"], reply: "Example Tower, 5th floor 👍", reason: "From your note" }],
  log: [
    { phase: "done", tool: "list_chats", result: "4 chats", at: now - 240000 },
    { phase: "done", tool: "get_messages", result: "5 messages from \"Family\"", at: now - 200000 },
    { phase: "done", tool: "get_pending_replies", result: "1 chat waiting for a reply", at: now - 90000 },
    { phase: "done", tool: "suggest_reply", result: "suggested a reply for \"Ahmed (Team Lead)\" (waiting for you)", at: now - 85000 },
    { phase: "done", tool: "send_message", result: "sent to \"Family\" after the countdown", at: now - 30000 },
  ],
};

const fakeChrome = (storeJson) => `
  window.__store = ${storeJson};
  window.chrome = {
    runtime: { id: "demo", onMessage: { addListener(f){ (window.__l ||= []).push(f); } }, sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async (k) => { const o = {}; for (const x of [].concat(k)) if (x in window.__store) o[x] = window.__store[x]; return o; },
                        set: async (o) => Object.assign(window.__store, o) },
               onChanged: { addListener(){} } },
    tabs: { query: async () => [] },
  };`;

// A generic two-pane messaging layout using the same element hooks as WhatsApp Web.
const row = (name, preview, time, unread, selected) => `
  <div role="listitem"><div class="row"${selected ? ' aria-selected="true"' : ""}>
    <div class="av">${name[0]}</div>
    <div class="col"><div class="top"><span dir="auto" title="${name}">${name}</span><div class="time">${time}</div></div>
    <div class="bot"><span title="${preview}">${preview}</span>${unread ? `<span class="badge" aria-label="${unread} unread messages">${unread}</span>` : ""}</div></div>
  </div></div>`;
const msg = (dir, who, time, text) => `
  <div role="row"><div data-id="${dir === "out" ? "true" : "false"}_demo_${Math.random().toString(36).slice(2)}" class="b ${dir}">
    <div data-pre-plain-text="[${time}, 30/10/2026] ${who}: "><span class="selectable-text"><span>${text}</span></span><span class="t">${time}</span></div>
  </div></div>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; background:#e9edef; }
  .app { display:grid; grid-template-columns: 340px 1fr; height: 100vh; }
  #side { background:#fff; border-right:1px solid #d1d7db; display:flex; flex-direction:column; }
  .head { height:56px; background:#f0f2f5; display:flex; align-items:center; padding:0 16px; font-weight:600; color:#3b4a54; justify-content:space-between; }
  .demo { font-size:11px; font-weight:600; color:#8696a0; letter-spacing:.06em; }
  .search { padding:8px 12px; } .search div { background:#f0f2f5; border-radius:8px; padding:8px 12px; color:#8696a0; }
  .row { display:flex; gap:12px; padding:10px 14px; border-bottom:1px solid #f0f2f5; }
  .row[aria-selected="true"] { background:#f0f2f5; }
  .av { width:44px; height:44px; border-radius:50%; background:#cfd8dc; display:grid; place-items:center; font-weight:600; color:#54656f; flex:none; }
  .col { flex:1; min-width:0; } .top, .bot { display:flex; justify-content:space-between; gap:8px; }
  .top span { font-weight:500; color:#111b21; } .time { font-size:12px; color:#667781; }
  .bot span[title] { color:#667781; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .badge { background:#25a366; color:#fff; border-radius:999px; font-size:11px; padding:1px 7px; flex:none; }
  #main { display:flex; flex-direction:column; background:#efeae2; }
  #main header { height:56px; background:#f0f2f5; display:flex; align-items:center; gap:12px; padding:0 16px; }
  #main header span { font-weight:500; }
  .msgs { flex:1; padding:20px 8%; display:flex; flex-direction:column; gap:6px; overflow:hidden; }
  .b { max-width:65%; padding:6px 10px 6px; border-radius:8px; box-shadow:0 1px .5px rgba(0,0,0,.13); background:#fff; }
  .b.out { align-self:flex-end; background:#d9fdd3; } .b.in { align-self:flex-start; }
  .t { font-size:11px; color:#667781; margin-left:10px; float:right; margin-top:4px; }
  footer { background:#f0f2f5; padding:10px 16px; display:flex; gap:10px; align-items:center; }
  footer [contenteditable] { flex:1; background:#fff; border-radius:8px; padding:10px 12px; min-height:20px; }
  footer button { border:0; background:transparent; font-size:20px; color:#54656f; }
  ${ext("content/privacy.css")}
</style></head><body><div class="app">
  <div id="side"><div class="head">Chats <span class="demo">DEMO DATA</span></div>
    <div class="search"><div contenteditable="true">Search</div></div>
    <div id="pane-side">
      ${row("Family", "Dinner at 8?", "21:41", 0, true)}
      ${row("Ahmed (Team Lead)", "Where's the office again?", "21:38", 1)}
      ${row("Project Phoenix", "Sara: deploy is green ✅", "20:12", 3)}
      ${row("Gym Buddies", "Leg day tomorrow?", "Yesterday", 0)}
    </div></div>
  <div id="main"><header><div class="av" style="width:36px;height:36px">F</div><span dir="auto" title="Family">Family</span></header>
    <div class="msgs">
      ${msg("in", "Mum", "21:30", "Are you coming home tonight?")}
      ${msg("out", "Me", "21:32", "Yes, leaving office at 7")}
      ${msg("in", "Mum", "21:41", "Dinner at 8?")}
    </div>
    <footer><div contenteditable="true"></div><button aria-label="Send"><span data-icon="send">➤</span></button></footer>
  </div>
</div></body></html>`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 680 }, deviceScaleFactor: 2 });

  async function waPage(storeOverrides = {}) {
    const p = await ctx.newPage();
    await p.setContent(page);
    await p.addScriptTag({ content: fakeChrome(JSON.stringify({ ...store, ...storeOverrides })) });
    for (const f of ["content/selectors.js", "content/reader.js", "content/main.js"]) await p.addScriptTag({ content: ext(f) });
    await p.waitForTimeout(1300);
    return p;
  }
  const callTool = (p, tool, args) => p.evaluate(([tool, args]) => { for (const f of window.__l) f({ kind: "tool", tool, args }, null, () => {}); }, [tool, args]);
  const send = (p, msg) => p.evaluate((msg) => { for (const f of window.__l) f(msg, null, () => {}); }, msg);

  // 1. Send countdown (real send_message flow, captured mid-countdown)
  let p = await waPage({ sendDelaySec: 5 });
  callTool(p, "send_message", { chat: "Family", text: "Yes, see you at 8 🙂" });
  await p.waitForSelector(".wa-bridge-confirm--toast");
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(OUT, "send-countdown.png") });
  await p.close();

  // 2. Auto-reply suggestion card
  p = await waPage();
  await send(p, { kind: "showSuggestion", suggestion: store.suggestions[0] });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, "auto-reply-suggestion.png") });
  await p.close();

  // 3. Blur mode, one row hovered
  p = await waPage({ blur: true });
  await p.waitForTimeout(400);
  await p.hover('#pane-side [role="listitem"]:nth-child(2)');
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, "blur-mode.png") });
  await p.close();

  // 4. Side panel (real sidepanel.html + sidepanel.js)
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 380, height: 1500 });
  const html = ext("sidepanel.html").replace('<script src="sidepanel.js"></script>', "");
  await sp.setContent(html);
  await sp.addScriptTag({ content: fakeChrome(JSON.stringify(store)) });
  await sp.addScriptTag({ content: ext("sidepanel.js") });
  await sp.waitForTimeout(500);
  const h = await sp.evaluate(() => document.documentElement.scrollHeight);
  await sp.setViewportSize({ width: 380, height: h });
  await sp.screenshot({ path: path.join(OUT, "side-panel.png") });

  await browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
