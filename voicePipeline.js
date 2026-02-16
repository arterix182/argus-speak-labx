/* voicePipeline.js (PRO)
   Endpoints:
   - POST /api/stt  (multipart/form-data: file)
   - POST /api/chat (json: { userText, mode? })
   - POST /api/tts  (json: { text })
*/

(function () {
  // ---------- Helpers ----------
  function vxSetState(state) {
    try {
      if (typeof window.VX_setAvatarState === "function") window.VX_setAvatarState(state);
    } catch (_) {}
  }

  async function safeJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { error: "Non-JSON response", raw: text.slice(0, 500) }; }
  }

  // ---------- STT (multipart/form-data) ----------
  async function VX_transcribeAudio(blob) {
    if (!blob) throw new Error("No audio blob");

    vxSetState("thinking");

    const fd = new FormData();
    // nombre "file" para que tu Netlify Function lo lea fácil
    fd.append("file", blob, "audio.webm");

    const r = await fetch("/api/stt", {
      method: "POST",
      body: fd,
    });

    const j = await safeJson(r);
    if (!r.ok) throw new Error(JSON.stringify(j));
    return (j.text || "").trim();
  }

  // ---------- CHAT ----------
  async function VX_chatReply(userText, mode = "coach") {
    const clean = (userText || "").trim();
    if (!clean) throw new Error("Empty userText");

    vxSetState("thinking");

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userText: clean, mode }),
    });

    const j = await safeJson(r);
    if (!r.ok) throw new Error(JSON.stringify(j));
    return (j.reply || j.text || "").trim();
  }

  // ---------- TTS ----------
  async function VX_ttsAudio(text) {
    const clean = (text || "").trim();
    if (!clean) throw new Error("Empty text");

    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean }),
    });

    if (!r.ok) {
      const j = await safeJson(r);
      throw new Error(JSON.stringify(j));
    }

    return await r.arrayBuffer(); // audio bytes
  }

  // ---------- AUDIO PLAY (speaking sync) ----------
  async function VX_playAudio(arrayBuf) {
    if (!arrayBuf) throw new Error("No audio buffer");

    // speaking cuando empieza
    vxSetState("speaking");

    const blob = new Blob([arrayBuf], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);

    // iOS/Chrome: si está bloqueado, al menos no crashea
    a.onended = () => {
      URL.revokeObjectURL(url);
      vxSetState("idle");
    };
    a.onerror = () => {
      URL.revokeObjectURL(url);
      vxSetState("idle");
    };

    // Reproduce
    try {
      await a.play();
    } catch (e) {
      // Si el navegador bloquea autoplay, volvemos a idle y soltamos error
      vxSetState("idle");
      throw e;
    }

    return a; // por si quieres detenerlo
  }

  // Exponer (IMPORTANTE: nombres estables)
  window.VX_transcribeAudio = VX_transcribeAudio;
  window.VX_chatReply = VX_chatReply;
  window.VX_ttsAudio = VX_ttsAudio;
  window.VX_playAudio = VX_playAudio;

  console.log("✅ voicePipeline loaded", {
    stt: typeof window.VX_transcribeAudio,
    chat: typeof window.VX_chatReply,
    tts: typeof window.VX_ttsAudio,
    play: typeof window.VX_playAudio,
  });
})();



