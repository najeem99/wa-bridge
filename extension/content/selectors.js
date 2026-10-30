// All WhatsApp Web selectors live here. WhatsApp changes its page structure
// every few months; when a tool stops working, this is the only file to fix.
// Each entry is a list of fallbacks, tried in order.
window.WA_SELECTORS = {
  sidePane: ["#pane-side"],
  chatRow: ['#pane-side [role="listitem"]', '#pane-side [role="row"]'],
  rowTitle: ['span[dir="auto"][title]', "span[title]"],
  rowUnread: ['span[aria-label*="unread message"]', 'span[aria-label*="unread"]'],
  searchBox: ['#side div[contenteditable="true"]', '#side input[type="text"]'],
  main: ["#main"],
  mainTitle: ['#main header span[dir="auto"]', "#main header span[title]"],
  message: ["#main div.message-in, #main div.message-out"],
  messageMeta: ["[data-pre-plain-text]"],
  messageText: ["span.selectable-text", ".copyable-text span[dir]"],
  composeBox: ['#main footer div[contenteditable="true"]'],
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
