// voiceRecorder.js (COMPLETO) — usa VX_* y evita redeclare

(() => {
  if (window.__VX_voiceRecorderLoaded) {
    console.warn("⚠️ VX voiceRecorder already loaded, skipping");
    return;
  }
  window.__VX_voiceRecorderLoaded = true;

  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;

  function setState(s) {
    window.__voiceState?.(s);
    console.log("STATE:", s);
  }

  function log(who, msg) {
    window.__voiceLog?.(who, msg);
    console.log(`${who}:`, msg);
  }

  async function VX_startRec() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    startedAt = Date.now();

    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    mediaRecorder.start();
    setState("listening");
    console.log("🎙️ recording...");
  }

  function VX_stopRec() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder) return reject(new Error("No recorder"));
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        resolve(blob);
      };
      try { mediaRecorder.stop(); } catch (e) { reject(e); }
    });
  }

  async function VX_runVoiceTurn() {
    try {
      setState("thinking");

      const blob = await VX_stopRec();

      // evita “STT vacío” por grabaciones cortas
      const ms = Date.now() - startedAt;
      if (ms < 700) {
        setState("idle");
        log("SYS", "Habla al menos 1 segundo. Intenta de nuevo.");
        return;
      }

      log("SYS", "STT...");
      const text = await window.VX_transcribeAudio(blob);

      if (!text) {
        setState("idle");
        log("SYS", "No se detectó voz. Habla más fuerte o acércate al mic.");
        return;
      }
      log("YOU", text);

      log("SYS", "CHAT...");
      const reply = await window.VX_chatReply(text);
      log("BOT", reply);

      // TTS opcional: si /api/tts no existe, no truena la app, solo te avisa
      log("SYS", "TTS...");
      try {
        setState("speaking");
        const buf = await window.VX_ttsAudio(reply);
        await window.VX_playAudio(buf);
      } catch (ttsErr) {
        setState("idle");
        log("SYS", "TTS no disponible aún (ok).");
        console.warn("TTS error (ignored):", ttsErr);
      }

      setState("idle");
    } catch (e) {
      console.error("❌ Voice turn failed:", e);
      setState("error");
      alert("Falló voz/IA: " + (e?.message || e));
    }
  }

  // Exporta handlers para el HTML
  window.VX_startRec = VX_startRec;
  window.VX_runVoiceTurn = VX_runVoiceTurn;

  console.log("✅ voiceRecorder loaded (VX)");
})();




