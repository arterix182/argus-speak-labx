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
  // Nota: evita multipart porque Netlify a veces "pierde" el file.
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
  // ✅ Tu backend /api/chat está pidiendo "userText" (no "message")
  window.VX_chatReply = async function (userText, ctx = {}) {
    const text = (userText || "").trim();
    if (!text) return "";

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        userText: text,              // ✅ CLAVE CORRECTA
        history: ctx.history || [],
        mode: ctx.mode || "call",
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

    // ---------------- TTS (OpenAI /api/tts: voz consistente + baja latencia) ----------------
  // Requiere netlify/functions/tts.js y OPENAI_API_KEY en Netlify.
  // Optimización: forzamos tts-1 (más rápido) y recortamos el texto a 1–2 frases para evitar esperas largas.
  window.VX_ttsSpeak = async function (text, opts = {}) {
    const t = String(text || "").trim();
    if (!t) return;

    // ✅ Para VOZ: máximo ~240 caracteres (1–2 frases). El texto completo puede seguir viéndose en pantalla.
    const tSpeak = t.length > 240 ? (t.slice(0, 240).replace(/\s+\S*$/, "") + "…") : t;

    const payload = {
      text: tSpeak,
      // ✅ Forzamos modelo rápido para conversación
      model: "tts-1",
      // ✅ Voz femenina consistente
      voice: (opts.voice || "nova"),
      // ✅ Formato ligero
      format: (opts.format || "mp3"),
      // ✅ Habla más lento para aprender (no afecta el tiempo de “reacción”, solo la dicción)
      speed: (typeof opts.speed === "number" ? opts.speed : 0.85),
      // Solo aplica si usas gpt-4o-mini-tts (tu tts.js ya lo maneja)
      instructions: opts.instructions
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
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error("TTS returned empty audio");
    }

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

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      // Importante: deja el error legible en log
      const errTxt = await r.text();
      throw new Error(`TTS ${r.status}: ${errTxt}`);
    }

    // Netlify regresa audio como bytes (base64) con Content-Type de audio/*
    const audioBlob = await r.blob();
    if (!audioBlob || audioBlob.size === 0) {
      throw new Error("TTS returned empty audio");
    }

    const url = URL.createObjectURL(audioBlob);
    const a = new Audio(url);
    a.preload = "auto";

    try {
      await a.play();
      await new Promise((resolve) => {
        a.onended = () => resolve();
        a.onerror = () => resolve(); // no bloqueamos el flujo si el dispositivo falla al reproducir
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


