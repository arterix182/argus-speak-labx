// js/voicePipeline.js (STT + CHAT, globals que espera voiceRecorder)
(() => {
  "use strict";

  async function jsonOrThrow(r, label = "HTTP") {
    const txt = await r.text();
    let j = {};
    try { j = txt ? JSON.parse(txt) : {}; }
    catch { j = { error: txt }; }

    if (!r.ok) {
      const msg =
        (j && (j.error?.message || j.error || j.message))
          ? (j.error?.message || j.error || j.message)
          : (txt || ("HTTP " + r.status));
      throw new Error(`${label} ${r.status}: ${msg}`);
    }
    return j;
  }

  // ---------------- STT ----------------
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

    const j = await jsonOrThrow(r, "STT");
    return (j.text || "").trim();
  };

  // ✅ Alias que espera voiceRecorder.js
  window.VX_transcribeAudio = async function (blob, opts = {}) {
    return await window.VX_sttTranscribe(blob, opts);
  };

  // ---------------- CHAT ----------------
  // ✅ Esta es la que te está faltando: VX_chatReply
  // Recibe texto y devuelve texto de respuesta.
  window.VX_chatReply = async function (userText, ctx = {}) {
    const text = (userText || "").trim();
    if (!text) return "";

    // Endpoint de chat (si tu proyecto usa otro, cámbialo aquí)
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        message: text,
        // opcional: historial / modo / systemPrompt
        history: ctx.history || [],
        mode: ctx.mode || "default",
      }),
    });

    const j = await jsonOrThrow(r, "CHAT");

    // Soporta varias formas de respuesta
    const reply =
      j.reply ??
      j.text ??
      j.message ??
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ??
      "";

    return String(reply || "").trim();
  };

  console.log("✅ voicePipeline loaded", {
    VX_sttTranscribe: typeof window.VX_sttTranscribe,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_chatReply: typeof window.VX_chatReply,
  });
})();

