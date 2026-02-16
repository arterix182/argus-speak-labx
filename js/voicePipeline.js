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
        mode: ctx.mode || "default",
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

  // ---------------- TTS (Browser SpeechSynthesis) ----------------
  window.VX_ttsSpeak = async function (text, opts = {}) {
    const t = String(text || "").trim();
    if (!t) return;

    if (!("speechSynthesis" in window)) {
      console.warn("speechSynthesis not supported");
      return;
    }

    // Cancela cualquier voz previa
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(t);

    // Idioma por defecto: inglés
    // Si quieres que hable español: "es-MX"
    utter.lang = opts.lang || "en-US";
    utter.rate = typeof opts.rate === "number" ? opts.rate : 1.0;
    utter.pitch = typeof opts.pitch === "number" ? opts.pitch : 1.0;
    utter.volume = typeof opts.volume === "number" ? opts.volume : 1.0;

    // Selección opcional de voz
    const wantName = (opts.voiceName || "").toLowerCase();
    const voices = window.speechSynthesis.getVoices?.() || [];
    if (voices.length) {
      const picked =
        (wantName && voices.find(v => (v.name || "").toLowerCase().includes(wantName))) ||
        voices.find(v => (v.lang || "").toLowerCase().startsWith((utter.lang || "").toLowerCase())) ||
        voices[0];
      if (picked) utter.voice = picked;
    }

    await new Promise((resolve) => {
      utter.onend = () => resolve();
      utter.onerror = () => resolve(); // no bloqueamos el flujo por TTS
      window.speechSynthesis.speak(utter);
    });
  };

  console.log("✅ voicePipeline loaded", {
    VX_sttTranscribe: typeof window.VX_sttTranscribe,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_chatReply: typeof window.VX_chatReply,
    VX_ttsSpeak: typeof window.VX_ttsSpeak,
  });
})();
