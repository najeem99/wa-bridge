// Page test: loads the real content scripts into a mock WhatsApp Web page
// (both the older and newer page layouts) and exercises every feature.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const idl = createRequire(import.meta.url)("jsdom/lib/jsdom/living/generated/utils.js");

const ext = fileURLToPath(new URL("../extension/content/", import.meta.url));
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("pass:", m); };

const row = (name, preview, time, unread) => `
  <div role="listitem"><div>
    <span dir="auto" title="${name}">${name}</span><div>${time}</div>
    <span title="${preview}">${preview}</span>
    ${unread ? `<span aria-label="${unread} unread messages">${unread}</span>` : ""}
  </div></div>`;

const html = `<html><body>
  <div id="side"><div contenteditable="true" id="search"></div>
    <div id="pane-side">
      ${row("Family", "Dinner at 8?", "20:41", 2)}
      ${row("Boss", "Release tomorrow", "Yesterday", 0)}
      ${row("Secret", "private stuff", "19:02", 1)}
      ${row("Sam 🙂", "Reached home?", "22:01", 0)}
    </div></div>
  <div id="main"></div>
</body></html>`;

const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://web.whatsapp.com/" });
const { window } = dom;
const doc = window.document;

// Make clicking a row open that chat, like WhatsApp does.
const chats = {
  Family: [["[20:30, 26/10/2026] Mum: ", "Are you coming?", "in"], ["[20:35, 26/10/2026] Me: ", "Yes", "out"], ["[20:41, 26/10/2026] Mum: ", "Dinner at 8?", "in"]],
};
doc.getElementById("pane-side").addEventListener("mousedown", (e) => {
  const rowEl = e.target.closest('[role="listitem"]');
  const name = rowEl.querySelector("span[title]").getAttribute("title");
  // Like WhatsApp: the clicked chat becomes the selected one in the sidebar.
  doc.querySelectorAll("#pane-side [aria-selected]").forEach((x) => x.removeAttribute("aria-selected"));
  rowEl.firstElementChild.setAttribute("aria-selected", "true");
  if (name === "Sam 🙂") {
    // Newer WhatsApp layout: no message-in/out classes, message IDs in data-id,
    // and messages appear a moment after the chat opens.
    doc.getElementById("main").innerHTML =
      `<header><span dir="auto">online</span></header><div role="application" id="msglist"></div>` +
      `<footer><div contenteditable="true"></div><button aria-label="Send"><span data-icon="send"></span></button></footer>`;
    setTimeout(() => {
      const ml = doc.getElementById("msglist");
      if (!ml) return; // chat was switched before the messages loaded
      ml.innerHTML = `
        <div role="row"><div data-id="false_15550001234@c.us_A1"><div><div data-pre-plain-text="[21:58, 26/10/2026] Sam 🙂: ">
          <span class="selectable-text"><span>Did you eat?</span></span></div></div></div></div>
        <div role="row"><div data-id="true_15550001234@c.us_A2"><div><div data-pre-plain-text="[21:59, 26/10/2026] Me: ">
          <div class="quoted"><span class="selectable-text">Did you eat?</span></div>
          <span class="selectable-text"><span>Yes, pasta</span></span></div></div></div></div>
        <div role="row"><div data-id="false_15550001234@c.us_A3"><div><img alt=""></div></div></div>
        <div role="row"><div data-id="false_15550001234@c.us_A4"><div><div data-pre-plain-text="[22:01, 26/10/2026] Sam 🙂: ">
          <span class="selectable-text"><span>Reached home?</span></span></div></div></div></div>`;
    }, 600);
    return;
  }
  const msgs = (chats[name] || []).map(([meta, text, dir]) =>
    `<div class="message-${dir}"><div class="copyable-text" data-pre-plain-text="${meta}"><span class="selectable-text">${text}</span></div></div>`).join("");
  doc.getElementById("main").innerHTML =
    `<header><span dir="auto" title="${name}">${name}</span></header>${msgs}<footer><div contenteditable="true"></div>` +
    `<button aria-label="Send"><span data-icon="send"></span></button></footer>`;
});
// WhatsApp's Send button: posts whatever is in the box, then empties it.
const reallySent = [];
doc.getElementById("main").addEventListener("click", (e) => {
  const btn = e.target.closest('button[aria-label="Send"]');
  if (!btn) return;
  const box = doc.querySelector("#main footer [contenteditable]");
  if (!box.textContent.trim()) return;
  reallySent.push(box.textContent);
  box.insertAdjacentHTML("beforebegin", "");
  doc.querySelector("#main footer").insertAdjacentHTML("beforebegin",
    `<div class="message-out"><div class="copyable-text" data-pre-plain-text="[21:00, 26/10/2026] Me: "><span class="selectable-text">${box.textContent}</span></div></div>`);
  box.textContent = "";
});

// A click as if a real person did it (isTrusted = true).
const humanClick = (el) => {
  const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
  // Real mouse clicks come from the browser itself, not dispatchEvent (which always marks events untrusted).
  const impl = idl.implForWrapper(ev);
  impl.isTrusted = true;
  idl.implForWrapper(el)._dispatch(impl);
};
const dialogButton = (label) => [...doc.querySelectorAll(".wa-bridge-confirm button")].find((b) => b.textContent.startsWith(label));
const waitDialog = async () => { for (let i = 0; i < 100 && !doc.querySelector(".wa-bridge-confirm"); i++) await new Promise((r) => setTimeout(r, 20)); return doc.querySelector(".wa-bridge-confirm"); };

// jsdom has no execCommand; a minimal stand-in that types into the focused element.
const typed = [];
let enterPressed = false;
doc.addEventListener("keydown", (e) => { if (e.key === "Enter") enterPressed = true; });
doc.execCommand = (cmd, _ui, val) => {
  const el = doc.activeElement;
  if (cmd === "insertText") { el.textContent += val; typed.push(val); }
  if (cmd === "insertLineBreak") { el.textContent += "\n"; }
  if (cmd === "delete") { el.textContent = ""; }
  return true;
};

// Fake chrome APIs.
const msgListeners = [];
const onMsg = (msg, sender, res) => { let async = false; for (const f of msgListeners) if (f(msg, sender, res) === true) async = true; return async; };
const store = { allowlist: ["Family", "Boss", "Sam 🙂"], allowAll: false, blur: false, sendMode: "confirm" };
const sent = [];
const storeListeners = [];
window.chrome = {
  storage: {
    local: { get: async () => ({ ...store }), set: async (o) => { Object.assign(store, o); for (const f of storeListeners) await f(o); } },
    onChanged: { addListener: (f) => storeListeners.push(f) },
  },
  runtime: { id: "test", onMessage: { addListener: (f) => msgListeners.push(f) }, sendMessage: async (m) => { sent.push(m); } },
};

for (const f of ["selectors.js", "reader.js", "main.js"]) window.eval(readFileSync(ext + "/" + f, "utf8"));
await new Promise((r) => setTimeout(r, 1300)); // let main.js find the sidebar

const call = (tool, args = {}) => new Promise((res) => onMsg({ kind: "tool", tool, args }, null, res));

let r = await call("list_chats");
assert(r.ok && r.data.chats.length === 4, "list_chats returns 4 chats");
const fam = r.data.chats.find((c) => c.name === "Family");
const sec = r.data.chats.find((c) => c.name === "Secret");
assert(fam.unread === 2 && fam.time === "20:41" && fam.preview === "Dinner at 8?", "Family: unread, time, preview parsed");
assert(sec.preview === undefined && sec.allowed === false, "Secret: preview withheld (not allowlisted)");

r = await call("list_chats", { unread_only: true });
assert(r.data.chats.map((c) => c.name).join() === "Family,Secret", "unread_only filter");

r = await call("get_messages", { chat: "Secret" });
assert(!r.ok && /allowlist/.test(r.error), "get_messages refuses non-allowlisted chat");
assert(!doc.querySelector("#main header"), "...and never opened it");

r = await call("get_messages", { chat: "family", limit: 2 });
assert(r.ok && r.data.messages.length === 2, "get_messages opens chat (case-insensitive) and returns last 2");
assert(r.data.messages[0].from === "me" && r.data.messages[0].direction === "out", "outgoing message marked as me");
assert(r.data.messages[1].from === "Mum" && r.data.messages[1].time === "20:41" && r.data.messages[1].text === "Dinner at 8?", "sender/time/text parsed");

r = await call("draft_reply", { chat: "Family", text: "Yes, see you\nat 8" });
const box = doc.querySelector("#main footer [contenteditable]");
assert(r.ok && r.data.sent === false && box.textContent === "Yes, see you\nat 8", "draft typed with line break");
assert(!enterPressed, "Enter key never pressed (nothing sent)");

r = await call("draft_reply", { chat: "Family", text: "again" });
assert(!r.ok && /unsent draft: "Yes, see you at 8"/.test(r.error), "won't overwrite an existing draft");

r = await call("draft_reply", { chat: "Secret", text: "hi" });
assert(!r.ok, "draft_reply refuses non-allowlisted chat");

// New messages: Family gets another message, Secret too.
r = await call("get_new_messages"); // resets the cursor
const famRow = [...doc.querySelectorAll('[role="listitem"]')][0];
famRow.querySelector('span[aria-label]').textContent = "3";
famRow.querySelector('span[aria-label]').setAttribute("aria-label", "3 unread messages");
famRow.querySelectorAll("span[title]")[1].setAttribute("title", "Bring bread");
const secRow = [...doc.querySelectorAll('[role="listitem"]')][2];
secRow.querySelector('span[aria-label]').textContent = "2";
await new Promise((r) => setTimeout(r, 900)); // observer debounce
r = await call("get_new_messages");
assert(r.ok && r.data.events.length === 1 && r.data.events[0].chat === "Family" && r.data.events[0].preview === "Bring bread", "new message in allowed chat reported");
assert(r.data.other_chats_with_activity === 1 && !JSON.stringify(r.data).includes("Secret"), "other chat counted but not named");

const notes = sent.filter((m) => m.kind === "notify");
assert(notes.length === 2 && notes.find((n) => n.chat === "Secret").preview === null, "notifications raised; hidden chat preview withheld");

r = await call("find_contact", { query: "Bo" });
assert(r.ok && r.data.results.length === 4 && doc.getElementById("search").textContent === "", "find_contact searches then clears the box");

// ---------- send_message ----------
const cbox = () => doc.querySelector("#main footer [contenteditable]");

r = await call("send_message", { chat: "Secret", text: "hi" });
assert(!r.ok && /allowlist/.test(r.error), "send_message refuses non-allowlisted chat");

r = await call("send_message", { chat: "Family", text: "Something else" });
assert(!r.ok && /unsent draft/.test(r.error) && cbox().textContent === "Yes, see you\nat 8", "won't clobber a different draft already in the box");
cbox().textContent = "";

// 1. Fake (script) click on Send is ignored; Enter does nothing; real click sends.
let p = call("send_message", { chat: "Family", text: "On my way" });
let dlg = await waitDialog();
assert(dlg && dlg.textContent.includes("To: Family") && dlg.textContent.includes("On my way"), "confirmation box shows chat and text");
assert(cbox().textContent === "On my way" && reallySent.length === 0, "text typed but not sent yet");
assert(doc.activeElement === dialogButton("Cancel"), "Cancel has focus, so a stray Enter can't send");
dialogButton("Send").click(); // isTrusted = false, like a page script
doc.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
assert(doc.querySelector(".wa-bridge-confirm") && reallySent.length === 0, "script click and Enter key do NOT send");
const confirmNote = sent.find((m) => m.kind === "confirmPending");
assert(confirmNote && confirmNote.chat === "Family", "background asked to notify that a confirm is waiting");
humanClick(dialogButton("Send"));
r = await p;
assert(r.ok && r.data.status === "sent" && r.data.text === "On my way" && r.data.edited_by_user === false, "real click sends; status=sent");
assert(reallySent.length === 1 && reallySent[0] === "On my way" && !doc.querySelector(".wa-bridge-confirm"), "exactly one message went out; dialog closed");
assert(sent.some((m) => m.kind === "confirmDone"), "confirm notification cleared");

// 2. User edits before confirming.
p = call("send_message", { chat: "Family", text: "Running late" });
await waitDialog();
cbox().textContent = "Running late, 10 min";
await new Promise((r) => setTimeout(r, 50));
assert(doc.querySelector(".wa-bridge-confirm-text").textContent === "Running late, 10 min", "preview follows the user's edit");
humanClick(dialogButton("Send"));
r = await p;
assert(r.data.status === "sent" && r.data.text === "Running late, 10 min" && r.data.edited_by_user === true, "edited text sent and reported back to Claude");

// 3. Cancel removes the text.
p = call("send_message", { chat: "Family", text: "Never mind" });
await waitDialog();
humanClick(dialogButton("Cancel"));
r = await p;
assert(r.data.status === "cancelled" && cbox().textContent === "" && reallySent.length === 2, "cancel: nothing sent, text removed");

// 4. Escape also cancels.
p = call("send_message", { chat: "Family", text: "Esc test" });
await waitDialog();
doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
r = await p;
assert(r.data.status === "cancelled" && reallySent.length === 2, "Escape cancels");

// 5. Keep as draft, then the same text is reused rather than typed twice.
p = call("send_message", { chat: "Family", text: "Draft me" });
await waitDialog();
humanClick(dialogButton("Keep as draft"));
r = await p;
assert(r.data.status === "kept_as_draft" && cbox().textContent === "Draft me" && reallySent.length === 2, "keep as draft: text stays, nothing sent");
p = call("send_message", { chat: "Family", text: "Draft me" });
await waitDialog();
assert(cbox().textContent === "Draft me", "existing identical draft reused, not doubled");

// 6. Only one confirmation at a time.
r = await call("send_message", { chat: "Family", text: "second" });
assert(!r.ok && /already waiting/.test(r.error), "second send while one is pending is refused");
humanClick(dialogButton("Cancel"));
await p;

// ---------- countdown mode (the new default) ----------
await window.chrome.storage.local.set({ sendMode: "countdown", sendDelaySec: 1 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 8. No click needed: sends by itself when the countdown ends.
p = call("send_message", { chat: "Family", text: "Auto hello" });
dlg = await waitDialog();
assert(dlg.classList.contains("wa-bridge-confirm--toast") && /Sending in 1s/.test(dlg.textContent), "countdown card shown (not a blocking modal)");
assert(reallySent.length === 2, "not sent before the countdown ends");
r = await p;
assert(r.ok && r.data.status === "sent" && /automatically/.test(r.data.how) && reallySent.at(-1) === "Auto hello", "sent automatically after countdown, no click");

// 9. Cancel during the countdown.
p = call("send_message", { chat: "Family", text: "Stop me" });
await waitDialog();
humanClick(dialogButton("Cancel"));
r = await p;
await sleep(1300);
assert(r.data.status === "cancelled" && reallySent.length === 3 && cbox().textContent === "", "cancel during countdown: nothing sent");

// 10. Send now skips the wait.
p = call("send_message", { chat: "Family", text: "Right now" });
await waitDialog();
const t0 = Date.now();
humanClick(dialogButton("Send now"));
r = await p;
assert(r.data.status === "sent" && /clicked/.test(r.data.how) && Date.now() - t0 < 900, "Send now sends immediately");

// 11. Editing the text pauses the countdown; it then waits for a Send click.
p = call("send_message", { chat: "Family", text: "Edit me" });
await waitDialog();
cbox().textContent = "Edit me please";
await sleep(1500);
assert(doc.querySelector(".wa-bridge-confirm") && /Paused/.test(doc.querySelector(".wa-bridge-confirm-title").textContent) && reallySent.length === 4, "editing pauses the countdown (not sent after 1.5s)");
humanClick(dialogButton("Send"));
r = await p;
assert(r.data.status === "sent" && r.data.text === "Edit me please" && r.data.edited_by_user, "edited text sent after click");

// ---------- chat already open, header doesn't show the plain name ----------
// 12. WhatsApp sometimes shows "online"/contact info in the header; the sidebar still marks the open chat.
const bossRow = [...doc.querySelectorAll('[role="listitem"]')][1];
bossRow.querySelector("span[title]").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
doc.querySelector("#main header").innerHTML = '<span dir="auto">online</span><span title="click here for contact info">click here for contact info</span>';
doc.querySelectorAll('[aria-selected]').forEach((e) => e.removeAttribute("aria-selected"));
bossRow.firstElementChild.setAttribute("aria-selected", "true");
let clicks = 0;
const countClicks = () => clicks++;
doc.getElementById("pane-side").addEventListener("mousedown", countClicks);
r = await call("get_messages", { chat: "Boss" });
assert(r.ok && clicks === 0, "already-open chat recognised from the sidebar; no re-click, no error");
p = call("send_message", { chat: "Boss", text: "Already open" });
r = await p;
assert(r.ok && r.data.status === "sent" && reallySent.at(-1) === "Already open" && clicks === 0, "send works when the chat was already open");
doc.getElementById("pane-side").removeEventListener("mousedown", countClicks);

// ---------- newer WhatsApp layout + delayed rendering ----------
// 14. get_messages waits for messages and reads them by data-id.
r = await call("get_messages", { chat: "Sam 🙂", limit: 5 });
if (!r.ok) console.log("ERROR:", r.error);
assert(r.ok && r.data.messages.length === 4, "new layout: found all 4 messages after they rendered late (" + (r.data.messages?.length) + ")");
const [m1, m2, m3, m4] = r.data.messages;
assert(m1.from === "Sam 🙂" && m1.direction === "in" && m1.text === "Did you eat?" && m1.time === "21:58", "incoming parsed from data-id false_");
assert(m2.from === "me" && m2.direction === "out" && m2.text === "Yes, pasta", "outgoing from data-id true_; quoted reply not mistaken for the message");
assert(m3.text === "[media or non-text message]", "photo marked as media");
assert(m4.text === "Reached home?", "latest message read");

// 15. inspect_layout reports structure only, never text or names.
r = await call("inspect_layout");
const layoutJson = JSON.stringify(r.data);
assert(r.ok && r.data.counts["data-id true_/false_"] === 4 && r.data.messages_found_by_reader === 4, "inspect_layout counts message rows");
assert(!/pasta|Reached|Did you eat|Sam|21:58/.test(layoutJson), "inspect_layout contains no message text, names or times");

// 16. Existing draft: error shows what's there; replace_draft clears it.
cbox().textContent = "half-typed thing";
r = await call("send_message", { chat: "Sam 🙂", text: "Yes, home now" });
assert(!r.ok && /half-typed thing/.test(r.error) && /replace_draft/.test(r.error), "blocked by draft: error reports the draft and how to replace it");
await window.chrome.storage.local.set({ sendDelaySec: 1 });
r = await call("send_message", { chat: "Sam 🙂", text: "Yes, home now", replace_draft: true });
assert(r.ok && r.data.status === "sent" && reallySent.at(-1) === "Yes, home now", "replace_draft: old draft cleared, new message sent");
cbox().textContent = "another draft";
r = await call("draft_reply", { chat: "Sam 🙂", text: "Drafted", replace_draft: true });
assert(r.ok && cbox().textContent === "Drafted", "draft_reply replace_draft works too");
cbox().textContent = "";

// ---------- auto-reply (content side) ----------
const humanType = (el, v) => { el.value = v; };
await window.chrome.storage.local.set({ autoReply: true, autoReplyChats: ["Sam 🙂"] });
await sleep(2300); // watcher takes its first look at the open chat
const incomingBefore = sent.filter((m) => m.kind === "incoming").length;

// 17. New incoming message in the open chat → event with full context, no phone-number ids.
doc.getElementById("msglist").insertAdjacentHTML("beforeend",
  `<div role="row"><div data-id="false_15550001234@c.us_B9"><div><div data-pre-plain-text="[22:20, 26/10/2026] Sam 🙂: "><span class="selectable-text"><span>What time is dinner?</span></span></div></div></div></div>`);
await sleep(2300);
let inc = sent.filter((m) => m.kind === "incoming").slice(incomingBefore);
assert(inc.length === 1 && inc[0].chat === "Sam 🙂" && inc[0].incoming[0] === "What time is dinner?", "open chat: new incoming message detected once");
assert(inc[0].context.length >= 4 && inc[0].context.at(-1).text === "What time is dinner?", "full recent conversation sent as context");
assert(!JSON.stringify(inc[0]).includes("15550001234") && !JSON.stringify(inc[0]).includes("@c.us"), "no phone numbers / message ids leave the tab");

// 18. Your own reply doesn't trigger anything.
doc.getElementById("msglist").insertAdjacentHTML("beforeend",
  `<div role="row"><div data-id="true_15550001234@c.us_C1"><div><div data-pre-plain-text="[22:21, 26/10/2026] Me: "><span class="selectable-text"><span>8pm</span></span></div></div></div></div>`);
await sleep(2300);
assert(sent.filter((m) => m.kind === "incoming").length === incomingBefore + 1, "outgoing message doesn't trigger a suggestion");

// 19. Sidebar: a chat not on the auto list never sends text; one on the list sends its preview.
const famRow2 = [...doc.querySelectorAll('[role="listitem"]')][0];
const bump = (row, n, preview) => {
  row.querySelector("span[aria-label]").textContent = String(n);
  row.querySelector("span[aria-label]").setAttribute("aria-label", n + " unread messages");
  row.querySelectorAll("span[title]")[1].setAttribute("title", preview);
};
bump(famRow2, 7, "Are you awake?");
await sleep(900);
assert(!sent.some((m) => m.kind === "incoming" && m.chat === "Family"), "chat not on auto-reply list: nothing sent for suggestions");
await window.chrome.storage.local.set({ autoReplyChats: ["Sam 🙂", "Family"] });
bump(famRow2, 8, "Hello??");
await sleep(900);
inc = sent.filter((m) => m.kind === "incoming" && m.chat === "Family");
assert(inc.length === 1 && inc[0].incoming[0] === "Hello??" && inc[0].context.length === 0, "sidebar: auto-reply chat sends just the preview");

// 20. Suggestion card: only a real click approves; edits are kept.
onMsg({ kind: "showSuggestion", suggestion: { id: "s1", chat: "Family", reply: "Yes, coming at 8", reason: "From the chat", incoming: ["Dinner at 8?"] } });
const card = doc.querySelector('.wa-bridge-sugg[data-sugg="s1"]');
assert(card && card.textContent.includes("Family") && card.querySelector("textarea").value === "Yes, coming at 8", "card shows chat, their message and the reply");
const cardBtn = (label) => [...card.querySelectorAll("button")].find((b) => b.textContent === label);
cardBtn("Approve & send").click(); // script click
await sleep(50);
assert(!sent.some((m) => m.kind === "suggestionDecision"), "script click on Approve is ignored");
humanType(card.querySelector("textarea"), "Yes, coming at 8:30");
humanClick(cardBtn("Approve & send"));
await sleep(50);
const dec = sent.find((m) => m.kind === "suggestionDecision");
assert(dec && dec.id === "s1" && dec.decision === "approve" && dec.text === "Yes, coming at 8:30", "real click approves, with the edited text");
assert(cardBtn("Skip").disabled, "buttons lock while sending");
onMsg({ kind: "suggestionFailed", id: "s1", error: "Draft in the way" });
assert(card.querySelector(".wa-bridge-sugg-err").textContent === "Draft in the way" && !cardBtn("Skip").disabled, "failure shown on the card, buttons usable again");
onMsg({ kind: "hideSuggestion", id: "s1" });
assert(!doc.querySelector('.wa-bridge-sugg[data-sugg="s1"]'), "card removed when done");

// 21. Approved send: goes to the chat, sends, returns you to the chat you were in.
const sentCount = reallySent.length;
let ar = await new Promise((res) => onMsg({ kind: "autoSend", chat: "Family", text: "Coming at 8:30" }, null, res));
await sleep(300);
assert(ar.ok && reallySent.length === sentCount + 1 && reallySent.at(-1) === "Coming at 8:30", "approved reply sent");
assert(window.WAReader.isChatOpen("Sam 🙂"), "returned to the chat you were reading");
ar = await new Promise((res) => onMsg({ kind: "autoSend", chat: "Boss", text: "x" }, null, res));
assert(!ar.ok && /auto-reply list/.test(ar.error) && reallySent.length === sentCount + 1, "chat not on auto list can't be sent to, even if approved");
ar = await new Promise((res) => onMsg({ kind: "autoDraft", chat: "Family", text: "Just a draft" }, null, res));
assert(ar.ok && reallySent.length === sentCount + 1 && cbox().textContent === "Just a draft", "Put in box: typed, not sent");
cbox().textContent = "";
await window.chrome.storage.local.set({ autoReply: false });

// 13. Switch off sending in the side panel.
await window.chrome.storage.local.set({ allowSend: false });
r = await call("send_message", { chat: "Family", text: "blocked" });
assert(!r.ok && /turned off/.test(r.error) && !doc.querySelector(".wa-bridge-confirm"), "sending switched off in side panel: refused, no dialog");
assert(reallySent.length === 8, "total messages actually sent across all tests: 8");

console.log("ALL PAGE TESTS PASSED");
process.exit(0);
