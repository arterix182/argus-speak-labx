// voiceRecorder.js (COMPLETO)
(() => {
  if (window.__voiceRecorderLoaded) {
    console.warn("⚠️ voiceRecorder already loaded, skipping");
    return;
  }
  window.__voiceRecorderLoaded = true;

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

  async function startRec() {
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

  function stopRec() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder) return reject(new Error("No recorder"));
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        resolve(blob);
      };
      try { mediaRecorder.stop(); } catch (e) { reject(e); }
    });
  }

  async function runVoiceTurn() {
    try {
      setState("thinking");
      const blob = await stopRec();

      // Si grabó muy poquito, pide repetir (evita STT vacío)
      const ms = Date.now() - startedAt;
      if (ms < 700) {
        setState("idle");
        log("SYS", "Habla al menos 1 segundo. Intenta de nuevo.");
        return;
      }

      log("SYS", "STT...");
      const text = await window.transcribeAudio(blob);

      if (!text) {
        setState("idle");
        log("SYS", "No se detectó voz. Habla más fuerte o acércate al mic.");
        return;
      }
      log("YOU", text);

      log("SYS", "CHAT...");
      const reply = await window.chatReply(text);
      log("BOT", reply);

      // Si aún no tienes TTS, comenta este bloque
      log("SYS", "TTS...");
      setState("speaking");
      const buf = await window.ttsAudio(reply);
      await window.playAudio(buf);

      setState("idle");
    } catch (e) {
      console.error("❌ Voice turn failed:", e);
      setState("error");
      alert("Falló voz/IA: " + (e?.message || e));
    }
  }

  window.startRec = startRec;
  window.runVoiceTurn = runVoiceTurn;

  console.log("✅ voiceRecorder ready");
})();



