// Runs inside the WhatsApp Web tab. Answers tool calls, enforces the allowlist,
// watches for new messages and applies privacy mode.
(() => {
  // Don't run twice in one tab. A copy left over from before an extension
  // reload is dead (its chrome.runtime.id is gone), so it doesn't count.
  if (window.__waBridge && window.__waBridge.alive()) return;
  window.__waBridge = { alive: () => { try { return !!chrome.runtime?.id; } catch { return false; } } };

  const R = window.WAReader;
  let settings = { allowlist: [], allowAll: false, blur: false, allowSend: true, sendMode: "countdown", sendDelaySec: 5 };
  const CONFIRM_WINDOW_MS = 120_000;
  let pendingConfirm = null;
  const MAX_EVENTS = 200;
  let events = []; // { chat, unread, time, preview, at }
  let lastPoll = new Date().toISOString();
  let snapshot = new Map(); // name -> { unread, time, preview }

  // ---------- settings ----------
  const loadSettings = async () => {
    const s = await chrome.storage.local.get(["allowlist", "allowAll", "blur", "allowSend", "sendMode", "sendDelaySec", "autoReply", "autoReplyChats", "sttModel", "allowVoice"]);
    settings = {
      allowlist: s.allowlist || [], allowAll: !!s.allowAll, blur: !!s.blur, allowSend: s.allowSend !== false,
      autoReply: !!s.autoReply, autoReplyChats: s.autoReplyChats || [],
      sttModel: s.sttModel === "base" ? "base" : "small", allowVoice: s.allowVoice !== false,
      // "countdown": sends by itself after a few seconds unless cancelled. "confirm": waits for a Send click.
      sendMode: s.sendMode === "confirm" ? "confirm" : "countdown",
      sendDelaySec: Number(s.sendDelaySec) > 0 ? Number(s.sendDelaySec) : 5,
    };
    document.documentElement.classList.toggle("wa-bridge-blur", settings.blur);
  };
  chrome.storage.onChanged.addListener(loadSettings);
  loadSettings();

  const isAllowed = (name) =>
    settings.allowAll || settings.allowlist.some((a) => a.trim().toLowerCase() === (name || "").trim().toLowerCase());

  // Auto-reply has its own, separate list: a chat must be added there explicitly.
  const isAutoChat = (name) =>
    settings.autoReply && settings.autoReplyChats.some((a) => a.trim().toLowerCase() === (name || "").trim().toLowerCase());

  function refuse(name) {
    throw new Error(`"${name}" is not on the WA Bridge allowlist. The user can add it in the WA Bridge side panel.`);
  }

  // ---------- on-page "Claude is doing X" banner ----------
  let banner;
  function showActivity(text) {
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "wa-bridge-banner";
      document.body.appendChild(banner);
    }
    banner.textContent = "Claude · " + text;
    banner.classList.add("show");
    clearTimeout(showActivity.t);
    showActivity.t = setTimeout(() => banner.classList.remove("show"), 2500);
  }

  // ---------- send dialog ----------
  // mode "countdown": a small card counts down and sends by itself ("auto"),
  //   unless the user cancels, keeps it as a draft, or edits the text (which
  //   pauses the countdown so they can finish and click Send).
  // mode "confirm": a full-screen box that waits for a Send click.
  // Resolves to "auto", "send", "draft", "cancel" or "timeout".
  // A clicked "Send" only counts if a real person clicked it (isTrusted).
  function askToSend(chat, text, mode, delaySec, replyTo = null) {
    return new Promise((resolve) => {
      const countdown = mode === "countdown";
      const wrap = document.createElement("div");
      wrap.className = "wa-bridge-confirm" + (countdown ? " wa-bridge-confirm--toast" : "");
      wrap.setAttribute("role", "dialog");
      if (!countdown) wrap.setAttribute("aria-modal", "true");

      const card = document.createElement("div");
      card.className = "wa-bridge-confirm-card";
      const h = document.createElement("div");
      h.className = "wa-bridge-confirm-title";
      const to = document.createElement("div");
      to.className = "wa-bridge-confirm-to";
      to.textContent = "To: " + chat;
      const quote = document.createElement("div");
      quote.className = "wa-bridge-confirm-quote";
      if (replyTo) quote.textContent = `Replying to ${replyTo.from === "me" ? "your message" : replyTo.from}: “${replyTo.text.length > 90 ? replyTo.text.slice(0, 90) + "…" : replyTo.text}”`;
      const body = document.createElement("div");
      body.className = "wa-bridge-confirm-text";
      body.textContent = text;
      const hint = document.createElement("div");
      hint.className = "wa-bridge-confirm-hint";
      const bar = document.createElement("div");
      bar.className = "wa-bridge-confirm-bar";
      const fill = document.createElement("div");
      bar.appendChild(fill);

      const btns = document.createElement("div");
      btns.className = "wa-bridge-confirm-buttons";
      const mk = (label, cls) => Object.assign(document.createElement("button"), { textContent: label, className: cls, type: "button" });
      const cancel = mk("Cancel", "wa-bridge-btn");
      const draft = mk("Keep as draft", "wa-bridge-btn");
      const send = mk(countdown ? "Send now" : "Send", "wa-bridge-btn wa-bridge-btn-send");
      btns.append(cancel, draft, send);
      card.append(h, to);
      if (replyTo) card.appendChild(quote);
      card.append(body, hint);
      if (countdown) card.appendChild(bar);
      card.appendChild(btns);
      wrap.appendChild(card);
      document.body.appendChild(wrap);

      // Countdown: one plain timer for the send (stays accurate even if Chrome
      // slows the display updates in a background tab).
      let autoTimer = null;
      let paused = !countdown;
      const delayMs = delaySec * 1000;
      const started = Date.now();
      if (countdown) {
        autoTimer = setTimeout(() => done("auto"), delayMs);
        fill.style.animationDuration = delayMs + "ms";
        hint.textContent = "Edit the message box to pause. Esc cancels.";
      } else {
        h.textContent = "Claude wants to send a message";
        hint.textContent = "You can edit it in the message box first. Whatever is in the box when you click Send is what goes.";
      }

      function pause(reason) {
        if (paused) return;
        paused = true;
        clearTimeout(autoTimer);
        bar.remove();
        h.textContent = "Paused";
        hint.textContent = reason + " Click Send when you're ready.";
        send.textContent = "Send";
      }

      // Keep the preview in sync with the message box; editing pauses the countdown.
      const box = waQ("composeBox");
      const original = R.norm(text);
      const sync = () => {
        const t = box && R.norm(box.textContent) ? box.innerText || box.textContent : "";
        body.textContent = t || "(message box is empty)";
        if (R.norm(t) !== original) pause("You edited the message.");
      };
      const mo = box ? new MutationObserver(sync) : null;
      mo?.observe(box, { subtree: true, childList: true, characterData: true });

      const tick = setInterval(() => {
        const elapsed = Date.now() - started;
        if (!paused) {
          h.textContent = `Sending in ${Math.max(0, Math.ceil((delayMs - elapsed) / 1000))}s`;
          return;
        }
        const left = Math.max(0, Math.ceil((CONFIRM_WINDOW_MS - elapsed) / 1000));
        cancel.textContent = `Cancel (${left}s)`;
        if (left === 0) done("timeout");
      }, 250);
      if (countdown) h.textContent = `Sending in ${delaySec}s`;

      function done(result) {
        clearTimeout(autoTimer);
        clearInterval(tick);
        mo?.disconnect();
        document.removeEventListener("keydown", onKey, true);
        wrap.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === "Escape") { e.preventDefault(); done("cancel"); } }
      document.addEventListener("keydown", onKey, true);
      send.addEventListener("click", (e) => e.isTrusted !== false && done("send"));
      draft.addEventListener("click", () => done("draft"));
      cancel.addEventListener("click", () => done("cancel"));
      if (!countdown) cancel.focus(); // safe default, so a stray Enter or Space never sends
    });
  }

  async function clearComposeBox() {
    const box = waQ("composeBox");
    if (!box) return;
    box.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
  }

  // Decides what to do with whatever is already in the message box.
  // Returns "reuse" (same text already there) or "typed-needed" (box is empty / was cleared).
  async function prepareBox(box, text, replaceDraft) {
    const existing = R.norm(box.textContent);
    if (!existing) return "typed-needed";
    if (existing === R.norm(text)) return "reuse";
    if (!replaceDraft) {
      const shown = existing.length > 200 ? existing.slice(0, 200) + "…" : existing;
      throw new Error(`That chat already has an unsent draft: "${shown}". ` +
        "Ask the user whether to replace it; if yes, call again with replace_draft: true.");
    }
    await clearComposeBox();
    if (R.norm(waQ("composeBox")?.textContent)) throw new Error("Couldn't clear the existing draft.");
    return "typed-needed";
  }

  // Opens the chat, makes the box ready and, if asked, attaches WhatsApp's
  // quoted reply to one message. Returns { box, replyTo } (replyTo = what Claude sees).
  async function prepareMessage(chat, text, replaceDraft, replyTo) {
    await R.openChat(chat);
    let target = null;
    if (replyTo) {
      await R.waitForMessages();
      target = R.findMessage(replyTo);
      if (!target) throw new Error(`No message matching "${replyTo}" in "${chat}". Use a ref from get_messages or a few exact words from the message. Nothing was typed.`);
    }
    const box = waQ("composeBox");
    if (!box) throw new Error("Could not find the message box.");
    const needTyping = await prepareBox(box, text, replaceDraft) === "typed-needed";
    if (target) await R.attachReply(target);
    if (needTyping) await R.typeInto(waQ("composeBox") || box, text);
    R.highlight(waQ("composeBox") || box);
    return { replyTo: target ? { ref: target.ref, from: target.from, time: target.time, text: target.text.slice(0, 200) } : null };
  }

  // ---------- tools ----------
  const tools = {
    async list_chats({ unread_only = false, limit = 30 } = {}) {
      showActivity("listing chats");
      let rows = R.readChatList();
      if (unread_only) rows = rows.filter((r) => r.unread > 0);
      return {
        note: "Only chats currently loaded in the sidebar are listed.",
        chats: rows.slice(0, limit).map((r) => ({
          name: r.name,
          unread: r.unread,
          time: r.time,
          allowed: isAllowed(r.name),
          preview: isAllowed(r.name) ? r.preview : undefined,
        })),
      };
    },

    async get_messages({ chat, limit = 5 }) {
      if (!isAllowed(chat)) refuse(chat);
      showActivity(`reading last ${limit} in "${chat}"`);
      await R.openChat(chat);
      await R.waitForMessages();
      // The internal id contains phone numbers, so it never leaves this tab.
      const messages = R.readMessages(limit).map(({ id, node, ...m }) => m);
      return messages.length
        ? { chat, messages }
        : { chat, messages, note: "No messages found on screen. If this chat does have messages, WhatsApp's layout may have changed; run inspect_layout." };
    },

    // Used by the local server's transcribe_voice tool. The audio goes to the
    // WA Bridge server on this computer only; Claude gets just the transcript.
    async get_voice_audio({ chat, message }) {
      if (!settings.allowVoice) throw new Error("Voice-note transcription is turned off in the WA Bridge side panel.");
      if (!isAllowed(chat)) refuse(chat);
      showActivity(`transcribing a voice note in "${chat}" (on this computer)`);
      await R.openChat(chat);
      await R.waitForMessages();
      let target;
      if (message) {
        target = R.findMessage(message);
        if (!target) throw new Error(`No message matching "${message}" in "${chat}".`);
        if (!target.voice) throw new Error("That message isn't a voice note.");
      } else {
        const voices = R.readMessages(300).filter((m) => m.voice);
        target = voices[voices.length - 1];
        if (!target) throw new Error(`No voice notes found on screen in "${chat}". Scroll up in WhatsApp if it's older.`);
      }
      const audio = await R.grabVoiceAudio(target);
      return { chat, ref: target.ref, from: target.from, time: target.time, date: target.date, duration: target.duration, stt_model: settings.sttModel, ...audio };
    },

    async inspect_layout() {
      showActivity("checking page layout (no message text)");
      return R.inspectLayout();
    },

    async get_new_messages({ since } = {}) {
      showActivity("checking new messages");
      scan();
      const from = since || lastPoll;
      lastPoll = new Date().toISOString();
      const fresh = events.filter((e) => e.at > from);
      const allowed = fresh.filter((e) => isAllowed(e.chat));
      const hiddenChats = new Set(fresh.filter((e) => !isAllowed(e.chat)).map((e) => e.chat));
      return {
        since: from,
        events: allowed.map(({ chat, unread, time, preview, at }) => ({ chat, unread, time, preview, seen_at: at })),
        other_chats_with_activity: hiddenChats.size,
        note: "Built from sidebar previews; nothing was marked as read. Use get_messages for full text.",
      };
    },

    async find_contact({ query }) {
      showActivity(`searching "${query}"`);
      await R.searchFor(query);
      const names = R.readChatList().map((r) => ({ name: r.name, allowed: isAllowed(r.name) }));
      await R.clearSearch();
      return { query, results: names };
    },

    async draft_reply({ chat, text, replace_draft = false, reply_to }) {
      if (!isAllowed(chat)) refuse(chat);
      showActivity(reply_to ? `drafting a reply to a message in "${chat}"` : `drafting reply in "${chat}"`);
      const { replyTo } = await prepareMessage(chat, text, replace_draft, reply_to);
      return { chat, drafted: true, sent: false, replying_to: replyTo || undefined, note: "Draft typed. The user must review and press send." };
    },

    async send_message({ chat, text, replace_draft = false, reply_to }) {
      if (!settings.allowSend) throw new Error("Sending is turned off in the WA Bridge side panel. Use draft_reply instead.");
      if (!isAllowed(chat)) refuse(chat);
      if (pendingConfirm) throw new Error("Another message is already waiting for the user's confirmation.");
      pendingConfirm = chat;
      try {
        showActivity(reply_to ? `preparing a reply in "${chat}"` : `preparing a message to "${chat}"`);
        const { replyTo } = await prepareMessage(chat, text, replace_draft, reply_to);

        const mode = settings.sendMode;
        chrome.runtime.sendMessage({ kind: "confirmPending", chat, mode, delaySec: settings.sendDelaySec }).catch(() => {});
        const choice = await askToSend(chat, text, mode, settings.sendDelaySec, replyTo);
        chrome.runtime.sendMessage({ kind: "confirmDone" }).catch(() => {});

        if (choice === "send" || choice === "auto") {
          if (!R.isChatOpen(chat)) {
            return { chat, status: "not_sent", reason: "The user switched to another chat before confirming. Nothing was sent." };
          }
          const box2 = waQ("composeBox");
          const finalText = box2 ? (box2.innerText || box2.textContent).trim() : "";
          if (!finalText) return { chat, status: "not_sent", reason: "The message box was empty." };
          await R.pressSend();
          showActivity(`sent to "${chat}"`);
          return {
            chat, status: "sent", text: finalText,
            how: choice === "auto" ? `sent automatically after the ${settings.sendDelaySec}s countdown` : "user clicked Send",
            replying_to: replyTo || undefined,
            edited_by_user: R.norm(finalText) !== R.norm(text),
          };
        }
        if (choice === "cancel") {
          await clearComposeBox();
          if (replyTo) await R.cancelReply();
          return { chat, status: "cancelled", note: "The user cancelled. The text was removed. Do not retry unless asked." };
        }
        if (choice === "draft") {
          return { chat, status: "kept_as_draft", note: "The user kept it as a draft to finish themselves. Nothing was sent." };
        }
        return { chat, status: "timed_out", note: "No answer within 2 minutes. The text is left as a draft; nothing was sent." };
      } finally {
        pendingConfirm = null;
      }
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.kind === "tool") {
      const fn = tools[msg.tool];
      if (!fn) { sendResponse({ ok: false, error: `Unknown tool ${msg.tool}` }); return; }
      Promise.resolve()
        .then(() => fn(msg.args || {}))
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // async response
    }
    if (msg.kind === "chatNames") {
      // For the side panel's autocomplete only; not a Claude tool call.
      sendResponse(R.readChatList().map((r) => r.name));
    }
  });

  // ---------- new-message watcher ----------
  function scan() {
    const now = new Date().toISOString();
    const rows = R.readChatList();
    const first = snapshot.size === 0;
    for (const r of rows) {
      const prev = snapshot.get(r.name);
      const changed = prev && (r.unread > prev.unread || (r.unread > 0 && r.preview !== prev.preview));
      if (changed && !first) {
        const ev = { chat: r.name, unread: r.unread, time: r.time, preview: r.preview, at: now };
        events.push(ev);
        if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
        if (r.unread > (prev.unread || 0)) {
          chrome.runtime.sendMessage({
            kind: "notify",
            chat: r.name,
            allowed: isAllowed(r.name),
            preview: isAllowed(r.name) ? r.preview : null,
          }).catch(() => {});
          // Auto-reply for a chat that isn't open: all we have is the sidebar preview.
          if (isAutoChat(r.name) && !R.isChatOpen(r.name) && r.preview) {
            chrome.runtime.sendMessage({ kind: "incoming", chat: r.name, incoming: [r.preview], context: [] }).catch(() => {});
          }
        }
      }
      snapshot.set(r.name, { unread: r.unread, time: r.time, preview: r.preview });
    }
  }

  // Auto-reply for the chat that's open: WhatsApp doesn't count unread there,
  // so watch for a new incoming message at the bottom and send full context.
  const lastIncomingSeen = new Map(); // chat -> message id
  function watchOpenChat() {
    if (!settings.autoReply) return;
    const name = R.currentChatName();
    if (!name || !isAutoChat(name)) return;
    const msgs = R.readMessages(12);
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    const prevId = lastIncomingSeen.get(name);
    if (last.direction !== "in") { lastIncomingSeen.set(name, last.id); return; } // you already replied
    lastIncomingSeen.set(name, last.id);
    if (prevId === undefined || prevId === last.id) return; // first look, or nothing new
    chrome.runtime.sendMessage({
      kind: "incoming", chat: name,
      incoming: [last.text],
      context: msgs.map(({ id, node, ref, ...m }) => m), // ids hold phone numbers; keep them here
    }).catch(() => {});
  }
  setInterval(watchOpenChat, 2000);

  // ---------- suggestion cards (bottom left) ----------
  function stack() {
    let s = document.querySelector(".wa-bridge-sugg-stack");
    if (!s) { s = document.createElement("div"); s.className = "wa-bridge-sugg-stack"; document.body.appendChild(s); }
    return s;
  }
  const cardFor = (id) => [...document.querySelectorAll(".wa-bridge-sugg")].find((c) => c.dataset.sugg === id);
  function hideSuggestion(id) { cardFor(id)?.remove(); }

  function showSuggestion(sug) {
    hideSuggestion(sug.id);
    // One card per chat: a newer suggestion replaces the older one.
    document.querySelectorAll(".wa-bridge-sugg").forEach((c) => c.dataset.chat === sug.chat && c.remove());
    const card = document.createElement("div");
    card.className = "wa-bridge-sugg";
    card.dataset.sugg = sug.id;
    card.dataset.chat = sug.chat;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text ?? "" });

    const title = el("div", "wa-bridge-sugg-title", "Suggested reply · " + sug.chat);
    const said = el("div", "wa-bridge-sugg-said", "“" + (sug.incoming?.[sug.incoming.length - 1] || "") + "”");
    const box = el("textarea", "wa-bridge-sugg-text");
    box.value = sug.reply;
    box.rows = Math.min(6, Math.max(2, Math.ceil(sug.reply.length / 40)));
    const why = el("div", "wa-bridge-sugg-why", sug.reason || "");
    const err = el("div", "wa-bridge-sugg-err");
    const btns = el("div", "wa-bridge-confirm-buttons");
    const mk = (label, cls) => Object.assign(document.createElement("button"), { textContent: label, className: cls, type: "button" });
    const skip = mk("Skip", "wa-bridge-btn");
    const toBox = mk("Put in box", "wa-bridge-btn");
    const approve = mk("Approve & send", "wa-bridge-btn wa-bridge-btn-send");
    btns.append(skip, toBox, approve);
    card.append(title, said, box, why, err, btns);
    stack().appendChild(card);

    const decide = (decision) => {
      for (const b of [skip, toBox, approve]) b.disabled = true;
      chrome.runtime.sendMessage({ kind: "suggestionDecision", id: sug.id, decision, text: box.value }).catch(() => {});
    };
    approve.addEventListener("click", (e) => { if (e.isTrusted !== false && box.value.trim()) decide("approve"); });
    toBox.addEventListener("click", () => decide("draft"));
    skip.addEventListener("click", () => decide("skip"));
  }

  function suggestionFailed(id, message) {
    const card = cardFor(id);
    if (!card) return;
    card.querySelector(".wa-bridge-sugg-err").textContent = message;
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }

  // Sends text the user already approved. Returns to the chat they were in.
  async function sendApproved(chat, text, { draftOnly = false } = {}) {
    if (!settings.autoReplyChats.some((a) => a.trim().toLowerCase() === chat.trim().toLowerCase())) {
      throw new Error(`"${chat}" is not on the auto-reply list.`);
    }
    const before = R.currentChatName();
    await R.openChat(chat);
    const box = waQ("composeBox");
    if (!box) throw new Error("Could not find the message box.");
    const existing = R.norm(box.textContent);
    if (existing && existing !== R.norm(text)) throw new Error(`There's already an unsent draft in "${chat}": "${existing.slice(0, 80)}". Clear it first.`);
    if (!existing) await R.typeInto(box, text);
    if (draftOnly) return { chat, status: "drafted" };
    await R.pressSend();
    if (before && before.toLowerCase() !== chat.toLowerCase()) R.openChat(before).catch(() => {});
    return { chat, status: "sent" };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.kind === "showSuggestion") { showSuggestion(msg.suggestion); return; }
    if (msg.kind === "hideSuggestion") { hideSuggestion(msg.id); return; }
    if (msg.kind === "suggestionFailed") { suggestionFailed(msg.id, msg.error); return; }
    if (msg.kind === "autoSend" || msg.kind === "autoDraft") {
      showActivity(msg.kind === "autoSend" ? `sending approved reply to "${msg.chat}"` : `putting reply in "${msg.chat}"`);
      sendApproved(msg.chat, msg.text, { draftOnly: msg.kind === "autoDraft" })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });

  let scanTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  });

  // WhatsApp loads slowly after the QR login; wait for the sidebar.
  const startWhenReady = setInterval(() => {
    const pane = waQ("sidePane");
    if (!pane) return;
    clearInterval(startWhenReady);
    scan();
    observer.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true });
    chrome.runtime.sendMessage({ kind: "waReady" }).catch(() => {});
  }, 1000);
})();
