(() => {
  if (window.__voiceRecorderLoaded) return;
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
    window.__voiceState?.("listening");
  }

  function stopRec() {
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        resolve(blob);
      };
      mediaRecorder.stop();
    });
  }

  async function runVoiceTurn() {
    try {
      const blob = await stopRec();
      window.__voiceState?.("thinking");

      const text = await window.transcribeAudio(blob);
      window.__voiceLog?.("YOU", text);

      const reply = await window.chatReply(text);
      window.__voiceLog?.("BOT", reply);

      window.__voiceState?.("speaking");
      const buf = await window.ttsAudio(reply);
      await window.playAudio(buf);

      window.__voiceState?.("idle");
    } catch (e) {
      console.error("❌ Voice turn failed:", e);
      window.__voiceState?.("error");
      alert("Falló voz/IA: " + (e?.message || e));
    }
  }

  window.startRec = startRec;
  window.runVoiceTurn = runVoiceTurn;

  console.log("✅ voiceRecorder ready");
})();


