// voiceRecorder.js
(() => {
  // Evita duplicar si el script se carga 2 veces
  if (window.__voiceRecorderLoaded) {
    console.warn("⚠️ voiceRecorder already loaded, skipping");
    return;
  }
  window.__voiceRecorderLoaded = true;

  let mediaRecorder;
  let chunks = [];

  async function startRec() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.start();
    console.log("🎙️ recording...");
  }

  function stopRec() {
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        console.log("🛑 stopped");
        const blob = new Blob(chunks, { type: "audio/webm" });
        resolve(blob);
      };
      mediaRecorder.stop();
    });
  }

  async function runVoiceTurn() {
    try {
      const blob = await stopRec();
      console.log("⏳ STT...");
      const text = await window.transcribeAudio(blob);
      console.log("YOU:", text);

      console.log("🤖 CHAT...");
      const reply = await window.chatReply(text);
      console.log("BOT:", reply);

      console.log("🔊 TTS...");
      const buf = await window.ttsAudio(reply);
      await window.playAudio(buf);

    } catch (e) {
      console.error("❌ Voice turn failed:", e);
      alert("Falló voz/IA: " + (e?.message || e));
    }
  }

  // Exporta handlers globales para tu HTML
  window.startRec = startRec;
  window.runVoiceTurn = runVoiceTurn;

  console.log("✅ voiceRecorder loaded");
})();


