// voiceRecorder.js
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
    const text = await transcribeAudio(blob);
    console.log("YOU:", text);

    console.log("🤖 CHAT...");
    const reply = await chatReply(text);
    console.log("BOT:", reply);

    console.log("🔊 TTS...");
    const buf = await ttsAudio(reply);
    await playAudio(buf);
  } catch (e) {
    console.error("❌ Voice turn failed:", e);
    alert("Falló voz/IA. Revisa consola.");
  }
}
