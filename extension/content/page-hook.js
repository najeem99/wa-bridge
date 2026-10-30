// Runs in WhatsApp Web's own page context (not the extension's isolated world),
// because that's the only place the decrypted voice-note audio exists.
//
// It only watches for audio being played and tells the extension which blob URL
// holds it. While the extension is grabbing a voice note to transcribe, it mutes
// and stops playback so you don't hear it. It sends nothing anywhere.
(() => {
  if (window.__waBridgeHook) return;
  window.__waBridgeHook = true;

  const MUTE_ATTR = "data-wa-bridge-grab"; // set on <html> by the extension while grabbing
  const grabbing = () => document.documentElement.hasAttribute(MUTE_ATTR);
  const announce = (url, type) =>
    document.dispatchEvent(new CustomEvent("wa-bridge-audio", { detail: { url: String(url), type: type || "" } }));

  // Remember the type of every audio blob WhatsApp creates.
  const types = new Map();
  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    try { if (obj && typeof obj.type === "string" && obj.type.startsWith("audio/")) types.set(url, obj.type); } catch {}
    return url;
  };

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const el = this;
    const isGrab = grabbing();
    if (isGrab) { el.__waBridgeWasMuted = el.muted; el.muted = true; }
    const report = () => {
      const src = el.currentSrc || el.src;
      if (src && src.startsWith("blob:")) announce(src, types.get(src));
      if (isGrab) { try { el.pause(); el.currentTime = 0; } catch {} el.muted = !!el.__waBridgeWasMuted; }
    };
    let result;
    try { result = origPlay.apply(this, arguments); } catch (e) { report(); throw e; }
    if (el.currentSrc || el.src) report();
    else el.addEventListener("loadstart", report, { once: true });
    return result;
  };
})();
