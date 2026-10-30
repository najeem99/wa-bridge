// Real speech-to-text check (downloads the Whisper model once, ~75 MB).
// Run with: npm run test:voice   (skipped by plain `npm test`)
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribe } from "../server/transcribe.js";
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("pass:", m); };
const home = process.env.WA_BRIDGE_HOME || mkdtempSync(join(tmpdir(), "wa-bridge-voice-"));
const model = process.env.WA_BRIDGE_TEST_MODEL || "base";

const en = await transcribe(readFileSync(new URL("./fixtures/voice-en.ogg", import.meta.url)), { model, home });
assert(en.language === "en" && en.language_detected, "English detected automatically");
assert(/report before thursday/i.test(en.text) && /dinner/i.test(en.text), `English transcript: "${en.text}"`);

const ar = await transcribe(readFileSync(new URL("./fixtures/voice-ar.ogg", import.meta.url)), { model, home });
assert(ar.language === "ar", "Arabic detected automatically");
assert(/الطريق/.test(ar.text) && /دقائق/.test(ar.text), `Arabic transcript: "${ar.text}"`);
console.log("ALL VOICE TESTS PASSED");
