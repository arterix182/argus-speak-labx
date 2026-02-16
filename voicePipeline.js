/* js/voicePipeline.js
   STT -> CHAT -> TTS helpers (Netlify Functions)
*/
(function () {
  async function VX_blobToBase64(blob) {
    const ab = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // STT: intenta multipart primero; si falla, usa JSON base64 (server acepta ambos)
  async function VX_transcribeAudio(blob) {
    if (!blob) throw new Error("No audio blob");
    const url = "/api/stt";

    // 1) multipart/form-data
    try {
      const fd = new FormData();
      fd.append("file", blob, "audio.webm");
      const r = await fetch(url, { method: "POST", body: fd });
      const j = await r.json().catch(async () => ({ error: await r.text() }));
      if (!r.ok) throw new Error(JSON.stringify(j));
      return (j.text || "").trim();
    } catch (e) {
      // 2) JSON base64 fallback
      const audioBase64 = await VX_blobToBase64(blob);
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioBase64, mimeType: blob.type || "audio/webm" }),
      });
      const j = await r.json().catch(async () => ({ error: await r.text() }));
      if (!r.ok) throw new Error(JSON.stringify(j));
      return (j.text || "").trim();
    }
  }

  // Chat (con "memoria" ligera local)
  async function VX_chatReply(userText, opts = {}) {
    const clean = (userText || "").trim();
    if (!clean) throw new Error("Empty user text");

    const mode = opts.mode || "coach";
    const memory = JSON.parse(localStorage.getItem("VX_MEMORY") || "[]");

    const payload = { userText: clean, mode, memory };
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const j = await r.json().catch(async () => ({ error: await r.text() }));
    if (!r.ok) throw new Error(JSON.stringify(j));

    // guarda memoria (cap)
    const nextMem = Array.isArray(j.memory) ? j.memory : memory;
    localStorage.setItem("VX_MEMORY", JSON.stringify(nextMem.slice(-14)));

    return (j.reply || "").trim();
  }

  // TTS devuelve ArrayBuffer (audio/mpeg)
  async function VX_ttsAudio(text) {
    const clean = (text || "").trim();
    if (!clean) throw new Error("Empty text");
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });

    if (!r.ok) throw new Error(await r.text());
    return await r.arrayBuffer();
  }

  // Playback robusto
  let currentAudio = null;

  async function VX_playAudio(buf) {
    if (!buf) throw new Error("No audio buffer");
    // detén anterior
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.src = "";
        currentAudio = null;
      }
    } catch {}

    const blob = new Blob([buf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    currentAudio = a;

    await a.play().catch((e) => {
      URL.revokeObjectURL(url);
      throw e;
    });

    await new Promise((res) => {
      a.onended = () => res();
      a.onerror = () => res();
    });

    URL.revokeObjectURL(url);
    currentAudio = null;
  }

  // Desbloqueo audio para autoplay policies (Edge/Chrome)
  async function VX_unlockAudio() {
    try {
      const a = new Audio();
      a.src = "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAA=="; // dummy corto
      await a.play().catch(() => {});
      a.pause();
    } catch {}
  }

  // Exports globales
  window.VX_transcribeAudio = VX_transcribeAudio;
  window.VX_chatReply = VX_chatReply;
  window.VX_ttsAudio = VX_ttsAudio;
  window.VX_playAudio = VX_playAudio;
  window.VX_unlockAudio = VX_unlockAudio;

  console.log("✅ voicePipeline loaded", {
    transcribe: typeof window.VX_transcribeAudio,
    chat: typeof window.VX_chatReply,
    tts: typeof window.VX_ttsAudio,
    play: typeof window.VX_playAudio,
  });
})();







