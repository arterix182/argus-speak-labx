// js/voicePipeline.js (STT multipart OK + alias compat con voiceRecorder)
(() => {
  "use strict";

  async function jsonOrThrow(r) {
    const txt = await r.text();
    let j = {};
    try { j = txt ? JSON.parse(txt) : {}; }
    catch { j = { error: txt }; }

    if (!r.ok) {
      const msg = (j && (j.error || j.message))
        ? (j.error || j.message)
        : (txt || ("HTTP " + r.status));
      throw new Error(`STT ${r.status}: ${msg}`);
    }
    return j;
  }

  // ✅ STT principal (ya lo tenías)
  window.VX_sttTranscribe = async function (blob, opts = {}) {
    if (!blob || !blob.size) throw new Error("Empty audio blob");

    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", opts.mimeType || blob.type || "audio/webm");

    const r = await fetch("/api/stt", {
      method: "POST",
      body: fd,
      cache: "no-store",
    });

    const j = await jsonOrThrow(r);
    return (j.text || "").trim();
  };

  // ✅ ALIAS de compatibilidad (esto es lo que te faltaba)
  // voiceRecorder.js está buscando window.VX_transcribeAudio
  window.VX_transcribeAudio = async function (blob, opts = {}) {
    return await window.VX_sttTranscribe(blob, opts);
  };

  // Mantén tus otros exports si ya los tienes:
  // window.VX_chatReply = ...
  // window.VX_ttsSpeak = ...
  // window.VX_playAudio = ...

  console.log("✅ voicePipeline loaded", {
    VX_sttTranscribe: typeof window.VX_sttTranscribe,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
  });
})();
