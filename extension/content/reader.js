// Reads WhatsApp Web's visible page into plain JSON. No screenshots, no network.
(() => {
  const TIME_RE = /^(\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?|yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}\/\d{2,4})$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function highlight(el) {
    if (!el) return;
    el.classList.add("wa-bridge-highlight");
    setTimeout(() => el.classList.remove("wa-bridge-highlight"), 1500);
  }

  function rowName(row) {
    const t = waQ("rowTitle", row);
    return t ? norm(t.getAttribute("title") || t.textContent) : null;
  }

  function readRow(row) {
    const name = rowName(row);
    if (!name) return null;

    const badge = waQ("rowUnread", row);
    const unread = badge ? parseInt(norm(badge.textContent), 10) || 1 : 0;

    let time = null;
    for (const el of row.querySelectorAll("div, span")) {
      if (el.children.length === 0 && TIME_RE.test(norm(el.textContent))) { time = norm(el.textContent); break; }
    }

    // The last titled span that isn't the name is usually the message preview.
    const titled = [...row.querySelectorAll("span[title]")]
      .map((s) => norm(s.getAttribute("title")))
      .filter((t) => t && t !== name);
    const preview = titled.length ? titled[titled.length - 1] : null;

    return { name, unread, time, preview, el: row };
  }

  function readChatList() {
    return waQAll("chatRow").map(readRow).filter(Boolean);
  }

  function findRow(name) {
    const want = norm(name).toLowerCase();
    return readChatList().find((r) => r.name.toLowerCase() === want) || null;
  }

  function currentChatName() {
    return selectedRowName() || headerNames()[0] || null;
  }

  // WhatsApp listens for pointer events deep inside each row, so click the
  // chat's name (the innermost element) and let the events bubble up.
  function clickLikeAUser(el) {
    const target = el.querySelector("span[title]") || el;
    target.scrollIntoView?.({ block: "nearest" });
    const r = target.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...pos };
    const P = window.PointerEvent || MouseEvent;
    target.dispatchEvent(new P("pointerdown", { ...base, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    target.dispatchEvent(new P("pointerup", { ...base, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mouseup", base));
    target.dispatchEvent(new MouseEvent("click", base));
  }

  // All names shown in the open chat's header (WhatsApp shows the name in a
  // couple of different spans depending on chat type).
  function headerNames() {
    return [...document.querySelectorAll('#main header span[title], #main header span[dir="auto"]')]
      .map((s) => norm(s.getAttribute("title") || s.textContent))
      .filter(Boolean);
  }

  // The chat WhatsApp highlights as open in the sidebar.
  function selectedRowName() {
    const sel = document.querySelector('#pane-side [aria-selected="true"]');
    if (!sel) return null;
    const row = sel.closest('[role="listitem"], [role="row"]') || sel;
    return rowName(row);
  }

  // Two independent signals, because WhatsApp's header doesn't always carry
  // the plain chat name (e.g. it can show "online", "typing…" or contact info).
  function isChatOpen(name) {
    const want = norm(name).toLowerCase();
    if (!document.querySelector("#main")) return false;
    if (headerNames().some((n) => n.toLowerCase() === want)) return true;
    return (selectedRowName() || "").toLowerCase() === want;
  }

  async function waitFor(fn, timeout = 5000, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  async function typeInto(box, text) {
    box.focus();
    const lines = String(text).split(/\r?\n/);
    lines.forEach((line, i) => {
      // insertLineBreak is the same as Shift+Enter. We never fire an Enter key,
      // so nothing can be sent by accident.
      if (i > 0) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
  }

  // WhatsApp's search box changes between versions (an <input> or an editable
  // <div>, inside #side or not). Try the known selectors, then fall back to the
  // first visible text field in the left part of the window that isn't the
  // chat's message box.
  // Has a size on screen. (Where layout isn't computed at all, e.g. in tests, everything counts as visible.)
  function isVisible(el) {
    if (!document.documentElement.getBoundingClientRect().width) return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function findSearchBox() {
    for (const sel of window.WA_SELECTORS.searchBox) {
      let list = [];
      try { list = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hit = list.find((el) => !el.closest("#main") && isVisible(el));
      if (hit) return hit;
    }
    const fields = [...document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"], [contenteditable="true"]')]
      .filter((el) => !el.closest("#main") && !el.closest("footer") && isVisible(el));
    const left = fields.filter((el) => {
      const r = el.getBoundingClientRect?.();
      return !r || !r.width || r.left < window.innerWidth * 0.45;
    });
    return left[0] || null;
  }

  const isInput = (el) => el && el.tagName === "INPUT";

  async function clearSearch() {
    const box = findSearchBox();
    if (!box) return;
    box.focus();
    if (isInput(box)) {
      box.select();
      if (!document.execCommand("delete") || box.value) {
        box.value = "";
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      document.execCommand("selectAll");
      document.execCommand("delete");
    }
    box.blur();
  }

  async function searchFor(query) {
    const box = findSearchBox();
    if (!box) throw new Error("Could not find WhatsApp's search box. Run inspect_layout and share its 'search' section so the selectors can be updated.");
    await clearSearch();
    box.focus();
    if (isInput(box)) {
      if (!document.execCommand("insertText", false, query) || box.value !== query) {
        // Fallback for inputs that ignore execCommand: set the value the way React expects.
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(box, query);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } else {
      await typeInto(box, query);
    }
    await sleep(900); // let WhatsApp filter the list
  }

  // Opens a chat by exact name; falls back to WhatsApp search if it's not on screen.
  async function openChat(name) {
    if (isChatOpen(name)) return true;
    let row = findRow(name);
    let usedSearch = false;
    if (!row) {
      await searchFor(name);
      usedSearch = true;
      // WhatsApp's search can take a few seconds on big accounts; keep looking.
      row = await waitFor(() => findRow(name), 4000, 150);
    }
    if (!row) {
      if (usedSearch) await clearSearch();
      throw new Error(`No chat named "${name}" found.`);
    }
    highlight(row.el);
    clickLikeAUser(row.el);
    const ok = await waitFor(() => isChatOpen(name));
    if (usedSearch) await clearSearch();
    if (!ok) {
      const shown = headerNames();
      throw new Error(`Clicked "${name}" but the chat did not open. ` +
        (shown.length ? `Header shows: ${shown.slice(0, 3).map((s) => `"${s}"`).join(", ")}.` : "No chat header found (#main is empty)."));
    }
    await sleep(400); // let messages render
    return true;
  }

  // "[10:32, 26/10/2026] Ahmed: " -> { time, date, sender }
  function parseMeta(s) {
    const m = /^\[([^,\]]+),\s*([^\]]+)\]\s*(.*?):\s*$/.exec(s || "");
    return m ? { time: norm(m[1]), date: norm(m[2]), sender: norm(m[3]) } : { time: null, date: null, sender: null };
  }

  // Finds message elements in the open chat, most stable signal first:
  //  1. data-id="true_…" (sent by me) / "false_…" (received): the message's own WhatsApp ID
  //  2. elements carrying data-pre-plain-text (sender + time header of text messages)
  //  3. the old .message-in / .message-out classes
  const MSG_ID_RE = /^(true|false)_/;
  const outermost = (list) => list.filter((el) => !list.some((o) => o !== el && o.contains(el)));
  function messageNodes() {
    const main = document.querySelector("#main");
    if (!main) return [];
    // Newest layout: every message (text, voice, media) is a [data-testid="conv-msg-…"] block.
    let nodes = outermost([...main.querySelectorAll('[data-testid^="conv-msg-"]')]);
    if (nodes.length) return nodes;
    nodes = outermost([...main.querySelectorAll("[data-id]")].filter((el) => MSG_ID_RE.test(el.getAttribute("data-id") || "")));
    if (nodes.length) return nodes;
    const metas = [...main.querySelectorAll("[data-pre-plain-text]")];
    if (metas.length) return metas.map((m) => m.closest(".message-in, .message-out, [role='row']") || m);
    return waQAll("message");
  }

  // Sent-or-received, from the strongest signal available:
  //  1. data-id "true_…" / "false_…"   2. .message-out / .message-in
  //  3. delivery ticks (only your own messages have them)   4. bubble on the right half of the chat
  const TICK_RE = /^(msg-(check|dblcheck|time)|status-(check|dblcheck|time))|dblcheck|-check$/;
  function isOutgoing(node) {
    const id = node.getAttribute("data-id") || node.querySelector("[data-id]")?.getAttribute("data-id") || "";
    if (MSG_ID_RE.test(id)) return id.startsWith("true_");
    if (node.classList.contains("message-out") || node.querySelector(".message-out") || node.closest(".message-out")) return true;
    if (node.classList.contains("message-in") || node.querySelector(".message-in") || node.closest(".message-in")) return false;
    if ([...node.querySelectorAll("[data-icon]")].some((i) => TICK_RE.test(i.getAttribute("data-icon") || ""))) return true;
    const main = document.querySelector("#main");
    const bubble = node.querySelector('[data-testid="msg-container"]') || node;
    const b = bubble.getBoundingClientRect?.(), m = main?.getBoundingClientRect?.();
    if (b && m && b.width && m.width) return b.left + b.width / 2 > m.left + m.width / 2;
    return false;
  }

  // For messages with no sender/time header (voice notes, media): the clock time shown on the bubble.
  const CLOCK_RE = /^\d{1,2}[:.]\d{2}(\s?[ap]\.?m\.?)?$/i;
  function bubbleTimes(node) {
    return [...node.querySelectorAll("span, div")]
      .filter((el) => el.children.length === 0 && CLOCK_RE.test(norm(el.textContent)))
      .map((el) => norm(el.textContent));
  }

  function messageText(node, metaEl) {
    // Prefer the body inside the sender/time block, so a quoted reply isn't read as the message.
    const scope = metaEl || node;
    const spans = [...scope.querySelectorAll("span.selectable-text")];
    const el = spans.length ? spans[spans.length - 1] : waQ("messageText", node);
    if (el) return norm(el.innerText || el.textContent);
    if (metaEl) return norm(metaEl.innerText || metaEl.textContent) || null;
    return null;
  }

  function readMessages(limit) {
    return messageNodes().slice(-limit).map((node) => {
      const out = isOutgoing(node);
      const metaEl = node.matches?.("[data-pre-plain-text]") ? node : waQ("messageMeta", node);
      const meta = parseMeta(metaEl && metaEl.getAttribute("data-pre-plain-text"));
      const voice = !!voicePlayButton(node);
      const times = metaEl ? [] : bubbleTimes(node);
      const duration = voice ? voiceDuration(node) : null;
      if (!meta.time && times.length) meta.time = times[times.length - 1];
      const text = messageText(node, metaEl) || (voice ? `[voice message${duration ? " " + duration : ""}]` : "[media or non-text message]");
      const rawId = node.getAttribute("data-testid")?.replace(/^conv-msg-/, "") || node.getAttribute("data-id") || node.querySelector("[data-id]")?.getAttribute("data-id") || "";
      const id = rawId || `${meta.date}|${meta.time}|${out ? "out" : "in"}|${text.slice(0, 80)}`;
      return { id, ref: refFor(id), from: out ? "me" : meta.sender || "them", direction: out ? "out" : "in", time: meta.time, date: meta.date, text, ...(voice ? { voice: true, duration } : {}), node };
    });
  }

  function voicePlayButton(node) {
    for (const sel of window.WA_SELECTORS.voicePlayButton) {
      let el = null;
      try { el = node.querySelector(sel); } catch {}
      if (el) return el.closest('button, [role="button"]') || el;
    }
    return null;
  }
  function voiceDuration(node) {
    const t = bubbleTimes(node);
    // A voice bubble shows its length (0:12) before the clock time (07:30); with only one, it's the length.
    return t.length ? t[0] : null;
  }

  // Gets a voice note's decrypted audio. WhatsApp only decrypts it on play, so
  // press play with the page hook muting and stopping it, and catch the blob URL.
  async function grabVoiceAudio(msg) {
    const node = msg.node;
    node.scrollIntoView?.({ block: "center" });
    highlight(node);
    const existing = node.querySelector('audio[src^="blob:"]');
    let url = existing?.src || null, type = "";
    if (!url) {
      const btn = voicePlayButton(node);
      if (!btn) throw new Error("That message doesn't look like a voice note.");
      const got = new Promise((resolve) => {
        const on = (e) => { document.removeEventListener("wa-bridge-audio", on); resolve(e.detail); };
        document.addEventListener("wa-bridge-audio", on);
        setTimeout(() => { document.removeEventListener("wa-bridge-audio", on); resolve(null); }, 15000);
      });
      document.documentElement.setAttribute("data-wa-bridge-grab", "1");
      try {
        clickLikeAUser(btn);
        const detail = await got;
        if (!detail) throw new Error("WhatsApp didn't load the voice note within 15 seconds. Try playing it once yourself, then ask again.");
        url = detail.url; type = detail.type;
      } finally {
        document.documentElement.removeAttribute("data-wa-bridge-grab");
      }
    }
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) throw new Error("The voice note came back empty.");
    if (buf.length > 15 * 1024 * 1024) throw new Error("Voice note is too large to transcribe (over 15 MB).");
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { audio_base64: btoa(bin), bytes: buf.length, type: type || res.headers?.get?.("content-type") || "" };
  }

  // A short, stable handle for a message that Claude can pass back (reply_to).
  // One-way hash of the internal id, so the phone number in it never leaves the tab.
  function refFor(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return "m" + (h >>> 0).toString(36);
  }

  // Finds a message in the open chat by ref, or by words from its text (latest match wins).
  function findMessage(target) {
    const want = norm(target);
    if (!want) return null;
    const all = readMessages(300);
    const byRef = all.find((m) => m.ref === want);
    if (byRef) return byRef;
    const lower = want.toLowerCase();
    const matches = all.filter((m) => m.text.toLowerCase().includes(lower));
    return matches.length ? matches[matches.length - 1] : null;
  }

  // The quote preview above the message box: whatever sits in the footer
  // (or just above it) besides the message box itself.
  function quotePreviewText() {
    const footer = document.querySelector("#main footer");
    if (!footer) return "";
    const box = waQ("composeBox");
    const parts = [footer, footer.previousElementSibling].filter(Boolean);
    let text = "";
    for (const el of parts) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[contenteditable="true"], button').forEach((x) => x.remove());
      text += " " + (clone.textContent || "");
    }
    if (box) text = text.replace(box.textContent || "", "");
    return norm(text);
  }

  function findReplyItem() {
    const labels = window.WA_SELECTORS.replyLabels.map((l) => l.toLowerCase());
    for (const sel of window.WA_SELECTORS.menuItem) {
      let items = [];
      try { items = [...document.querySelectorAll(sel)]; } catch { continue; }
      const hit = items.find((el) => {
        const t = norm(el.getAttribute("aria-label") || el.textContent).toLowerCase();
        return labels.includes(t);
      });
      if (hit) return hit;
    }
    return null;
  }

  // Opens WhatsApp's own "Reply" on a message so the next message is sent as a quoted reply.
  async function attachReply(msg) {
    const node = msg.node;
    node.scrollIntoView?.({ block: "center" });
    highlight(node);
    const snippet = norm(msg.text).slice(0, 24).toLowerCase();
    const quoted = () => snippet && quotePreviewText().toLowerCase().includes(snippet);
    if (quoted()) return true; // already replying to it

    // 1. Right-click menu.
    const r = node.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const at = { bubbles: true, cancelable: true, view: window, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    node.dispatchEvent(new MouseEvent("contextmenu", at));
    let item = await waitFor(findReplyItem, 1200);

    // 2. Hover, then the message's menu button.
    if (!item) {
      for (const type of ["mouseover", "mouseenter", "mousemove"]) node.dispatchEvent(new MouseEvent(type, { ...at, button: 0 }));
      const btn = await waitFor(() => waQ("messageMenuButton", node), 1200);
      if (btn) { clickLikeAUser(btn.closest('[role="button"], button') || btn); item = await waitFor(findReplyItem, 1500); }
    }
    if (!item) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      throw new Error("Couldn't open WhatsApp's Reply option on that message (menu selectors may need updating). Nothing was typed.");
    }
    clickLikeAUser(item);
    if (!(await waitFor(quoted, 2500))) throw new Error("Clicked Reply but the quote didn't appear above the message box. Nothing was typed.");
    return true;
  }

  // Removes a quote preview, if there is one.
  async function cancelReply() {
    const footer = document.querySelector("#main footer");
    const scope = footer?.parentElement || footer;
    const btn = scope && waQ("quoteCloseButton", scope);
    if (btn && !btn.closest('[aria-label="Send"]')) clickLikeAUser(btn.closest('[role="button"], button') || btn);
  }

  // Messages render a moment after a chat opens; wait for them (an empty chat just times out).
  async function waitForMessages(timeout = 4000) {
    await waitFor(() => messageNodes().length > 0, timeout, 150);
    await sleep(250); // let the last few finish rendering
  }

  // Diagnostic: the page's structure with NO text content, so selectors can be
  // fixed without reading anyone's messages.
  function inspectLayout() {
    const main = document.querySelector("#main");
    const count = (sel, root = document) => { try { return root.querySelectorAll(sel).length; } catch { return -1; } };
    const skeleton = (el, depth = 0) => {
      if (!el || depth > 5) return null;
      const attrs = {};
      for (const a of el.attributes) {
        if (a.name === "data-id") attrs[a.name] = (a.value.match(MSG_ID_RE) || ["(other)"])[0] + "…";
        else if (["role", "aria-label", "title", "data-pre-plain-text", "dir", "tabindex", "contenteditable", "data-icon", "data-testid"].includes(a.name))
          attrs[a.name] = a.name === "role" || a.name === "dir" || a.name === "data-icon" || a.name === "data-testid" || a.name === "contenteditable" || a.name === "tabindex" ? a.value : "(present)";
        else if (a.name === "class") attrs.class = a.value.split(/\s+/).filter((c) => /message|selectable|copyable/.test(c)).join(" ") || "(obfuscated)";
      }
      return { tag: el.tagName.toLowerCase(), attrs, children: [...el.children].slice(0, 6).map((c) => skeleton(c, depth + 1)).filter(Boolean) };
    };
    const nodes = messageNodes();
    return {
      main_present: !!main,
      header_name_candidates: main ? count('header span[title], header span[dir="auto"]', main) : 0,
      selected_sidebar_row: !!document.querySelector('#pane-side [aria-selected="true"]'),
      counts: main ? {
        "data-id true_/false_": [...main.querySelectorAll("[data-id]")].filter((e) => MSG_ID_RE.test(e.getAttribute("data-id") || "")).length,
        "data-id (any)": count("[data-id]", main),
        "[data-pre-plain-text]": count("[data-pre-plain-text]", main),
        ".message-in/.message-out": count(".message-in, .message-out", main),
        "span.selectable-text": count("span.selectable-text", main),
        '[role="row"]': count('[role="row"]', main),
        '[role="application"]': count('[role="application"]', main),
        "compose box": count('footer [contenteditable="true"]', main),
      } : null,
      messages_found_by_reader: nodes.length,
      reader_summary: (() => {
        const msgs = readMessages(300);
        return { sent_by_you: msgs.filter((x) => x.direction === "out").length, received: msgs.filter((x) => x.direction === "in").length,
          voice_notes: msgs.filter((x) => x.voice).length, without_text: msgs.filter((x) => /^\[/.test(x.text)).length };
      })(),
      // Shapes only: letters and digits masked, so no ids or numbers are shown.
      message_id_shapes: [...new Set(nodes.slice(-6).map((n) => {
        const id = n.getAttribute("data-id") || n.querySelector("[data-id]")?.getAttribute("data-id") || "";
        return id.replace(/[A-Za-z0-9]+/g, (w) => (w === "true" || w === "false" ? w : "x")) || "(none)";
      }))],
      icons_in_recent_messages: [...new Set(nodes.slice(-8).flatMap((n) => [...n.querySelectorAll("[data-icon]")].map((i) => i.getAttribute("data-icon"))))].slice(0, 30),
      play_buttons_found: nodes.filter((n) => voicePlayButton(n)).length,
      search: (() => {
        const box = findSearchBox();
        const fields = [...document.querySelectorAll('input, [contenteditable="true"]')].filter((el) => !el.closest("#main"));
        const describe = (el) => {
          const r = el.getBoundingClientRect?.() || {};
          return {
            tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || undefined,
            role: el.getAttribute("role") || undefined,
            aria_label: el.getAttribute("aria-label") || undefined,       // WhatsApp's own UI text
            placeholder: el.getAttribute("placeholder") || undefined,     // WhatsApp's own UI text
            contenteditable: el.getAttribute("contenteditable") || undefined,
            in_side: !!el.closest("#side"), in_footer: !!el.closest("footer"),
            x: Math.round(r.left || 0), w: Math.round(r.width || 0),
          };
        };
        return { found: !!box, chosen: box ? describe(box) : null, candidates: fields.slice(0, 8).map(describe) };
      })(),
      last_message_skeleton: skeleton(nodes[nodes.length - 1] || main?.querySelector('[role="row"]:last-of-type')),
    };
  }

  // Presses WhatsApp's own Send button. Only ever called after the user clicked
  // Send in our confirmation box.
  async function pressSend() {
    const box = waQ("composeBox");
    const icon = waQ("sendButton");
    if (icon) {
      clickLikeAUser(icon.closest("button") || icon.parentElement || icon);
    } else if (box) {
      // Fallback if the button selector is out of date.
      box.focus();
      for (const type of ["keydown", "keypress", "keyup"]) {
        box.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    } else {
      throw new Error("Could not find the message box or Send button.");
    }
    // WhatsApp empties the message box once a message is sent.
    const sent = await waitFor(() => {
      const b = waQ("composeBox");
      return !b || !norm(b.textContent);
    }, 5000);
    if (!sent) throw new Error("Pressed Send but the text is still in the message box, so it probably wasn't sent. Check the WhatsApp tab.");
    return true;
  }

  window.WAReader = {
    readChatList, findRow, currentChatName, findSearchBox, isChatOpen, headerNames, openChat, readMessages, searchFor, clearSearch,
    typeInto, highlight, parseMeta, norm, pressSend, grabVoiceAudio, findMessage, attachReply, cancelReply, quotePreviewText, waitForMessages, inspectLayout,
  };
})();
