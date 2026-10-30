// Local speech-to-text for WhatsApp voice notes, using Whisper (open-source)
// through transformers.js. Runs entirely on this computer: the audio never
// leaves it. The model downloads once (to ~/.wa-bridge/models) on first use.

import { OggOpusDecoder } from "ogg-opus-decoder";
import { join } from "node:path";

const MODELS = {
  base: "onnx-community/whisper-base",   // ~80 MB, fast, fine for English
  small: "onnx-community/whisper-small", // ~250 MB, slower, better for Arabic, Malayalam, Hindi…
};
const MAX_SECONDS = 15 * 60;

// Languages Whisper can be asked to detect (its own language codes).
const LANGS = ["en", "ar", "ml", "hi", "ur", "ta", "te", "kn", "bn", "mr", "gu", "pa", "fa", "tr", "fr", "es", "pt",
  "de", "it", "ru", "uk", "pl", "nl", "zh", "ja", "ko", "id", "ms", "tl", "th", "vi", "sw", "so", "am", "ne", "si", "ps"];

let pipelinePromise = null;
let TensorClass = null;
let loadedModel = null;

async function getPipeline(modelKey, cacheDir, log) {
  const id = MODELS[modelKey] || MODELS.small;
  if (pipelinePromise && loadedModel === id) return pipelinePromise;
  loadedModel = id;
  pipelinePromise = (async () => {
    const { pipeline, env, Tensor } = await import("@huggingface/transformers");
    TensorClass = Tensor;
    env.cacheDir = cacheDir;
    env.allowLocalModels = false;
    log(`loading speech model ${id} (first time downloads it)…`);
    const asr = await pipeline("automatic-speech-recognition", id, { dtype: "q8", device: "cpu" });
    log("speech model ready");
    return asr;
  })();
  pipelinePromise.catch(() => { pipelinePromise = null; });
  return pipelinePromise;
}

// Opus (WhatsApp voice notes) or WAV → mono Float32 at 16 kHz, as Whisper expects.
export async function decodeAudio(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let channels, rate;
  if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) { // "OggS"
    const decoder = new OggOpusDecoder();
    await decoder.ready;
    const out = await decoder.decodeFile(u8);
    decoder.free();
    channels = out.channelData; rate = out.sampleRate;
  } else if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) { // "RIFF"
    ({ channels, rate } = decodeWav(u8));
  } else {
    throw new Error("Unsupported audio format (expected an Opus voice note or WAV).");
  }
  if (!channels?.length || !channels[0].length) throw new Error("The voice note decoded to no audio.");
  const mono = mixDown(channels);
  if (mono.length / rate > MAX_SECONDS) throw new Error(`Voice note is longer than ${MAX_SECONDS / 60} minutes.`);
  return { audio: resample(mono, rate, 16000), seconds: mono.length / rate };
}

function mixDown(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

// Averaging resampler: good enough for speech going down to 16 kHz.
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function decodeWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 12, fmt = null;
  while (p + 8 <= u8.length) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = dv.getUint32(p + 4, true);
    if (id === "fmt ") fmt = { channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true), format: dv.getUint16(p + 8, true) };
    if (id === "data" && fmt) {
      const n = fmt.channels, frames = Math.floor(size / (fmt.bits / 8) / n);
      const chans = Array.from({ length: n }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) for (let c = 0; c < n; c++) {
        const off = p + 8 + (f * n + c) * (fmt.bits / 8);
        chans[c][f] = fmt.format === 3 ? dv.getFloat32(off, true) : fmt.bits === 16 ? dv.getInt16(off, true) / 32768 : (u8[off] - 128) / 128;
      }
      return { channels: chans, rate: fmt.rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("Couldn't read the WAV file.");
}

// Whisper's own language detection: feed only the start token and see which
// language token the model expects next. (transformers.js otherwise assumes English.)
async function detectLanguage(asr, audio) {
  const inputs = await asr.processor(audio.slice(0, 16000 * 30));
  const sot = asr.tokenizer.convert_tokens_to_ids(["<|startoftranscript|>"])[0];
  const out = await asr.model({ ...inputs, decoder_input_ids: new TensorClass("int64", BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const V = out.logits.dims.at(-1);
  const last = out.logits.data.slice(out.logits.data.length - V);
  const ids = asr.tokenizer.convert_tokens_to_ids(LANGS.map((l) => `<|${l}|>`));
  let best = 0;
  for (let i = 1; i < LANGS.length; i++) if (last[ids[i]] > last[ids[best]]) best = i;
  return LANGS[best];
}

/**
 * @param {Uint8Array} bytes  the voice note file
 * @param {{model?: "base"|"small", language?: string, home: string, log?: Function}} opts
 */
export async function transcribe(bytes, { model = "small", language, home, log = () => {} } = {}) {
  const { audio, seconds } = await decodeAudio(bytes);
  const asr = await getPipeline(model, join(home, "models"), log);
  const started = Date.now();
  const lang = language || await detectLanguage(asr, audio);
  const result = await asr(audio, {
    task: "transcribe",
    language: lang,
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  });
  return {
    text: String(result.text || "").trim(),
    language: lang,
    language_detected: !language,
    seconds: Math.round(seconds * 10) / 10,
    model: MODELS[model] || MODELS.small,
    took_seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
