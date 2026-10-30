// All WhatsApp Web selectors live here. WhatsApp changes its page structure
// every few months; when a tool stops working, this is the only file to fix.
// Each entry is a list of fallbacks, tried in order.
window.WA_SELECTORS = {
  sidePane: ["#pane-side"],
  chatRow: ['#pane-side [role="listitem"]', '#pane-side [role="row"]'],
  rowTitle: ['span[dir="auto"][title]', "span[title]"],
  rowUnread: ['span[aria-label*="unread message"]', 'span[aria-label*="unread"]'],
  // Most specific first. reader.findSearchBox() adds a position-based fallback.
  searchBox: [
    'input[aria-label*="Search" i]:not(#main *)',
    '[contenteditable="true"][aria-label*="Search" i]:not(#main *)',
    'input[placeholder*="Search" i]:not(#main *)',
    '[role="textbox"][aria-label*="Search" i]:not(#main *)',
    '#side div[contenteditable="true"]',
    '#side input[type="text"]',
    '#side input:not([type])',
  ],
  main: ["#main"],
  mainTitle: ['#main header span[dir="auto"]', "#main header span[title]"],
  message: ["#main div.message-in, #main div.message-out"],
  messageMeta: ["[data-pre-plain-text]"],
  messageText: ["span.selectable-text", ".copyable-text span[dir]"],
  composeBox: ['#main footer div[contenteditable="true"]'],
  // Quoted replies. WhatsApp shows a per-message menu button on hover and a
  // context menu on right-click; both contain a "Reply" item.
  messageMenuButton: [
    '[aria-label="Context menu"]', '[aria-label*="menu" i]', '[data-icon="down-context"]',
    '[data-icon*="chevron-down"]', '[data-icon*="down"]',
  ],
  menuItem: ['[role="application"] li', '[role="menu"] [role="menuitem"]', '[role="menu"] li', 'li[role="button"]', '[role="menuitem"]'],
  replyLabels: ["Reply", "رد", "الرد", "Responder", "Répondre", "Antworten", "Rispondi", "जवाब दें", "Balas", "Yanıtla"],
  // The quote preview WhatsApp shows above the message box, and its close button.
  quoteCloseButton: ['[aria-label="Cancel reply"]', '[aria-label*="cancel" i]', '[data-icon="x"]', '[data-icon*="close"]'],
  sendButton: [
    '#main footer button[aria-label="Send"]',
    '#main footer [data-icon="send"]',
    '#main footer [data-icon="wds-ic-send-filled"]',
  ],
};

window.waQ = (key, root = document) => {
  for (const s of window.WA_SELECTORS[key]) {
    const el = root.querySelector(s);
    if (el) return el;
  }
  return null;
};

window.waQAll = (key, root = document) => {
  for (const s of window.WA_SELECTORS[key]) {
    const list = root.querySelectorAll(s);
    if (list.length) return [...list];
  }
  return [];
};
