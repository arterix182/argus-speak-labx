// js/voicePipeline.js (STT + CHAT + TTS; globals que espera voiceRecorder)
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

  // ---------------- STT (RAW body) ----------------
  // Nota: enviamos el blob directo (no multipart) para evitar errores de "Missing file" en Netlify.
  window.VX_sttTranscribe = async function (blob, opts = {}) {
    if (!blob || !blob.size) throw new Error("Empty audio blob");

    const r = await fetch("/api/stt", {
      method: "POST",
      headers: {
        "Content-Type": blob.type || "application/octet-stream",
        "X-Filename": opts.filename || "audio.webm",
        "X-MimeType": opts.mimeType || blob.type || "audio/webm",
      },
      cache: "no-store",
      body: blob,
    });

    const j = await jsonOrThrow(r, "STT");
    return (j.text || "").trim();
  };

  // ✅ Alias que espera voiceRecorder.js
  window.VX_transcribeAudio = async function (blob, opts = {}) {
    return await window.VX_sttTranscribe(blob, opts);
  };

  // ---------------- CHAT ----------------
  // ✅ Backend espera userText
  window.VX_chatReply = async function (userText, ctx = {}) {
    const text = (userText || "").trim();
    if (!text) return "";

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        userText: text,
        history: ctx.history || [],
        mode: ctx.mode || "call", // modo llamada por defecto
      }),
    });

    const j = await jsonOrThrow(r, "CHAT");

    const reply =
      j.reply ??
      j.text ??
      j.message ??
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ??
      "";

    return String(reply || "").trim();
  };

  // ---------------- TTS (OpenAI /api/tts) ----------------
  // ✅ OJO: ESTE ARCHIVO ES "script" NORMAL (NO module).
  // Por eso: TODOS los "await" van dentro de funciones async.
  window.VX_ttsSpeak = async function (text, opts = {}) {
    const t = String(text || "").trim();
    if (!t) return;

    // ✅ Para voz: recorta a 1–2 frases para que el TTS responda rápido
    const tSpeak = t.length > 240 ? (t.slice(0, 240).replace(/\s+\S*$/, "") + "…") : t;

    // ✅ Forzamos modelo rápido para conversación
    const payload = {
      text: tSpeak,
      model: "tts-1",
      voice: opts.voice || "nova",
      format: "mp3",
      speed: typeof opts.speed === "number" ? opts.speed : 0.85,
    };

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      throw new Error(`TTS ${r.status}: ${errTxt}`);
    }

    const audioBlob = await r.blob();
    if (!audioBlob || audioBlob.size === 0) throw new Error("TTS returned empty audio");

    const url = URL.createObjectURL(audioBlob);
    const a = new Audio(url);
    a.preload = "auto";

    try {
      await a.play();
      await new Promise((resolve) => {
        a.onended = () => resolve();
        a.onerror = () => resolve();
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  console.log("✅ voicePipeline loaded", {
    VX_sttTranscribe: typeof window.VX_sttTranscribe,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_chatReply: typeof window.VX_chatReply,
    VX_ttsSpeak: typeof window.VX_ttsSpeak,
  });
})();
