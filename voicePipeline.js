// js/voicePipeline.js (STT multipart OK)
(() => {
  "use strict";

  async function jsonOrThrow(r) {
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { j = { error: txt }; }
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j;
  }

  window.VX_sttTranscribe = async function(blob, opts = {}) {
    if (!blob || !blob.size) throw new Error("Empty audio blob");

    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", opts.mimeType || blob.type || "audio/webm");

    const r = await fetch("/api/stt", { method:"POST", body: fd, cache:"no-store" });
    const j = await jsonOrThrow(r);
    return (j.text || "").trim();
  };

  // Mantén tus otros exports si ya los tienes:
  // VX_chatReply, VX_ttsAudio, VX_playAudio...
  console.log("✅ voicePipeline loaded", { VX_sttTranscribe: typeof window.VX_sttTranscribe });
})();



