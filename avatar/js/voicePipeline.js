// js/voicePipeline.js (STT + CHAT + TTS; globals que espera voiceRecorder)
// FIX: evita "await" en funciones no-async (algunos deploys terminan quitando async). 
// Aquí el TTS NO usa await; usa Promises para que el archivo siempre cargue.
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
  // ✅ Tu backend /api/chat está pidiendo "userText"
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
        mode: ctx.mode || "call", // modo llamada por default
        maxOutputTokens: ctx.maxOutputTokens || 90, // 1–2 frases aprox
        temperature: typeof ctx.temperature === "number" ? ctx.temperature : 0.2,
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

  // ---------------- TTS (OpenAI /api/tts: voz consistente) ----------------
  // IMPORTANTE: NO usamos "await" aquí para evitar SyntaxError si el deploy te deja la función sin async.
  window.VX_ttsSpeak = function (text, opts = {}) {
    const t = String(text || "").trim();
    if (!t) return Promise.resolve();

    // ✅ Para voz: máximo 1–2 frases (reduce latencia brutal sin tocar el texto en pantalla)
    const tSpeak = t.length > 240 ? (t.slice(0, 240).replace(/\s+\S*$/, "") + "…") : t;

    const payload = {
      text: tSpeak,
      model: "tts-1",          // ✅ más rápido que tts-1-hd
      voice: "nova",           // ✅ voz femenina consistente
      format: "mp3",
      speed: 0.85              // ✅ más lento para aprender (NO afecta la latencia grande; afecta dicción)
    };

    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ ...payload, ...(opts || {}) }),
    })
      .then((r) => {
        if (!r.ok) {
          return r.text().then((errTxt) => {
            throw new Error(`TTS ${r.status}: ${errTxt}`);
          });
        }
        return r.blob();
      })
      .then((audioBlob) => {
        if (!audioBlob || audioBlob.size === 0) throw new Error("TTS returned empty audio");

        const url = URL.createObjectURL(audioBlob);
        const a = new Audio(url);
        a.preload = "auto";

        return a.play()
          .catch(() => {}) // autoplay policies: no truena la llamada
          .then(() => new Promise((resolve) => {
            a.onended = () => resolve();
            a.onerror = () => resolve();
          }))
          .finally(() => {
            try { URL.revokeObjectURL(url); } catch {}
          });
      });
  };

  console.log("✅ voicePipeline loaded", {
    VX_sttTranscribe: typeof window.VX_sttTranscribe,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_chatReply: typeof window.VX_chatReply,
    VX_ttsSpeak: typeof window.VX_ttsSpeak,
  });
})();


