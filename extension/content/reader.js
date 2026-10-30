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

  async function clearSearch() {
    const box = waQ("searchBox");
    if (!box) return;
    box.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");
    box.blur();
  }

  async function searchFor(query) {
    const box = waQ("searchBox");
    if (!box) throw new Error("Could not find WhatsApp's search box (selectors may need updating).");
    await clearSearch();
    await typeInto(box, query);
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
  function messageNodes() {
    const main = document.querySelector("#main");
    if (!main) return [];
    let nodes = [...main.querySelectorAll("[data-id]")].filter((el) => MSG_ID_RE.test(el.getAttribute("data-id") || ""));
    nodes = nodes.filter((el) => !nodes.some((o) => o !== el && o.contains(el))); // outermost only
    if (nodes.length) return nodes;
    const metas = [...main.querySelectorAll("[data-pre-plain-text]")];
    if (metas.length) return metas.map((m) => m.closest(".message-in, .message-out, [role='row']") || m);
    return waQAll("message");
  }

  function isOutgoing(node) {
    const id = node.getAttribute("data-id") || node.querySelector("[data-id]")?.getAttribute("data-id") || "";
    if (MSG_ID_RE.test(id)) return id.startsWith("true_");
    return node.classList.contains("message-out") || !!node.querySelector(".message-out") || !!node.closest(".message-out");
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
      const text = messageText(node, metaEl) || "[media or non-text message]";
      const rawId = node.getAttribute("data-id") || node.querySelector("[data-id]")?.getAttribute("data-id") || "";
      const id = MSG_ID_RE.test(rawId) ? rawId : `${meta.date}|${meta.time}|${out ? "out" : "in"}|${text.slice(0, 80)}`;
      return { id, from: out ? "me" : meta.sender || "them", direction: out ? "out" : "in", time: meta.time, date: meta.date, text };
    });
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
    readChatList, findRow, currentChatName, isChatOpen, headerNames, openChat, readMessages, searchFor, clearSearch,
    typeInto, highlight, parseMeta, norm, pressSend, waitForMessages, inspectLayout,
  };
})();
