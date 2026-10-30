// Server test: a real MCP client talks to server/index.js over stdio, and a
// stand-in extension answers over the localhost WebSocket.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "wa-bridge-test-"));
const env = { ...process.env, WA_BRIDGE_HOME: home, WA_BRIDGE_PORT: "8799", WA_BRIDGE_FAKE_STT: "1" };
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("pass:", m); };

const client = new Client({ name: "test", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [SERVER], env, stderr: "ignore" }));

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert(JSON.stringify(tools) === JSON.stringify(["draft_reply", "find_contact", "get_messages", "get_new_messages", "get_pending_replies", "inspect_layout", "list_chats", "send_message", "suggest_reply", "transcribe_voice"]), "10 tools listed: " + tools);

let r = await client.callTool({ name: "list_chats", arguments: {} });
assert(r.isError && /not connected/.test(r.content[0].text), "clear error when extension is absent");

const token = readFileSync(join(home, "token"), "utf8").trim();

// A web page (non-extension origin) must be rejected.
const evil = await new Promise((res) => {
  const w = new WebSocket("ws://127.0.0.1:8799", { origin: "https://evil.example" });
  w.on("open", () => res("opened")); w.on("error", () => res("rejected")); w.on("unexpected-response", () => res("rejected"));
});
assert(evil === "rejected", "web page origin is refused");

// Wrong token must be refused.
const bad = await new Promise((res) => {
  const w = new WebSocket("ws://127.0.0.1:8799", { origin: "chrome-extension://abc" });
  w.on("open", () => w.send(JSON.stringify({ type: "hello", token: "nope" })));
  w.on("close", (code) => res(code));
});
assert(bad === 4003, "wrong token is refused");

// Fake extension with the right token.
const ext = new WebSocket("ws://127.0.0.1:8799", { origin: "chrome-extension://abc" });
await new Promise((res) => {
  ext.on("open", () => ext.send(JSON.stringify({ type: "hello", token })));
  ext.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "ready") return res();
    if (m.type === "req") {
      if (m.tool === "get_messages" && m.args.chat === "Secret") {
        ext.send(JSON.stringify({ type: "res", id: m.id, ok: false, error: '"Secret" is not on the WA Bridge allowlist.' }));
      } else {
        ext.send(JSON.stringify({ type: "res", id: m.id, ok: true, data: { echo: m.tool, args: m.args } }));
      }
    }
  });
});

r = await client.callTool({ name: "get_messages", arguments: { chat: "Family" } });
const data = JSON.parse(r.content[0].text);
assert(!r.isError && data.echo === "get_messages" && data.args.limit === 5, "get_messages round trip, default limit 5");

r = await client.callTool({ name: "get_messages", arguments: { chat: "Secret" } });
assert(r.isError && /allowlist/.test(r.content[0].text), "allowlist refusal reaches Claude as an error");

// send_message must survive a slow human: the extension answers after 25s (past the normal 20s timeout).
const slowStart = Date.now();
ext.removeAllListeners("message");
ext.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type === "req" && m.tool === "send_message") {
    setTimeout(() => ext.send(JSON.stringify({ type: "res", id: m.id, ok: true, data: { chat: m.args.chat, status: "sent", text: m.args.text } })), 25000);
  }
});
r = await client.callTool({ name: "send_message", arguments: { chat: "Family", text: "hi" } }, undefined, { timeout: 60000 });
assert(!r.isError && JSON.parse(r.content[0].text).status === "sent" && Date.now() - slowStart >= 25000, "send_message waits for the user beyond the normal timeout");

// transcribe_voice: audio goes extension → server only; Claude gets text; the extension is told what Claude got.
const fixture = readFileSync(new URL("./fixtures/voice-en.ogg", import.meta.url));
const extLogs = [];
ext.removeAllListeners("message");
ext.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.type === "log") extLogs.push(m.entry);
  if (m.type === "req" && m.tool === "get_voice_audio") {
    ext.send(JSON.stringify({ type: "res", id: m.id, ok: true, data: { chat: m.args.chat, ref: "mabc12", from: "Sam", time: "07:00", duration: "0:06", stt_model: "base", audio_base64: fixture.toString("base64"), bytes: fixture.length } }));
  }
});
r = await client.callTool({ name: "transcribe_voice", arguments: { chat: "Family" } });
const tr = JSON.parse(r.content[0].text);
assert(!r.isError && tr.transcript === `[fake transcript of ${fixture.length} bytes]` && tr.from === "Sam" && tr.ref === "mabc12", "transcribe_voice returns the transcript");
assert(!r.content[0].text.includes("audio_base64") && !r.content[0].text.includes(fixture.toString("base64").slice(0, 40)), "no audio is sent to Claude, only text");
await new Promise((ok) => setTimeout(ok, 100));
assert(extLogs.some((e) => e.tool === "transcribe_voice" && e.shared?.transcript === tr.transcript), "side panel log is told exactly what transcript Claude got");

ext.close();
await client.close();
console.log("ALL SERVER TESTS PASSED");
process.exit(0);
