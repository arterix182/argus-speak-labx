/* voicePipeline.js
   Expone EXACTAMENTE lo que la UI/recorder esperan:
   - VX_chatReply(text, {mode})
   - VX_ttsAudio(text) -> ArrayBuffer (mp3)
   - VX_playAudio(arrayBuffer) -> reproduce
   - VX_sttTranscribe(blob, {mimeType}) -> texto

   Además deja alias compatibles con tu versión vieja:
   - VX_chat === VX_chatReply
   - VX_transcribeAudio === VX_sttTranscribe
   - VX_ttsSpeak(text) = ttsAudio + playAudio
*/

(() => {
  "use strict";

  async function jsonOrThrow(r) {
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch { throw new Error("Non-JSON response: " + txt.slice(0, 160)); }
  }

  async function VX_chatReply(userText, opts = {}) {
    const clean = (userText || "").trim();
    if (!clean) throw new Error("Empty text");

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ userText: clean, mode: opts.mode || "coach" })
    });

    const j = await jsonOrThrow(r);
    if (!r.ok) throw new Error(j.error || "chat failed");
    return (j.reply || "").trim();
  }

  async function VX_sttTranscribe(blob, opts = {}) {
    if (!blob || !blob.size) throw new Error("Empty audio blob");

    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", opts.mimeType || blob.type || "audio/webm");

    const r = await fetch("/api/stt", { method: "POST", body: fd, cache: "no-store" });
    const j = await jsonOrThrow(r);
    if (!r.ok) throw new Error(j.error || "stt failed");
    return (j.text || "").trim();
  }

  async function VX_ttsAudio(text) {
    const clean = (text || "").trim();
    if (!clean) throw new Error("Empty TTS text");

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ text: clean })
    });

    if (!r.ok) {
      const j = await jsonOrThrow(r).catch(() => ({ error: "tts failed" }));
      throw new Error(j.error || "tts failed");
    }

    return await r.arrayBuffer();
  }

  // Reproductor robusto (no depende de AudioContext)
  async function VX_playAudio(arrayBuffer) {
    if (!arrayBuffer) throw new Error("No audio buffer");
    const blob = new Blob([arrayBuffer], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);

    try {
      const a = new Audio(url);
      a.crossOrigin = "anonymous";

      // autoplay policy: intenta play y si falla, lanza error claro
      await a.play();
      await new Promise((res) => {
        a.onended = res;
        a.onerror = res;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function VX_ttsSpeak(text) {
    const buf = await VX_ttsAudio(text);
    await VX_playAudio(buf);
  }

  // Exports nuevos (los que te faltan)
  window.VX_chatReply = VX_chatReply;
  window.VX_ttsAudio = VX_ttsAudio;
  window.VX_playAudio = VX_playAudio;
  window.VX_sttTranscribe = VX_sttTranscribe;

  // Alias viejos (para no romper lo que ya tenías)
  window.VX_chat = VX_chatReply;
  window.VX_transcribeAudio = async (blob) => VX_sttTranscribe(blob, { mimeType: blob?.type || "audio/webm" });
  window.VX_ttsSpeak = VX_ttsSpeak;

  console.log("✅ voicePipeline loaded", {
    VX_chatReply: typeof window.VX_chatReply,
    VX_ttsAudio: typeof window.VX_ttsAudio,
    VX_playAudio: typeof window.VX_playAudio,
    VX_sttTranscribe: typeof window.VX_sttTranscribe
  });
})();
