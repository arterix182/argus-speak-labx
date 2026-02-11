async function blobToBase64(blob) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function transcribeAudio(blob) {
  const audioBase64 = await blobToBase64(blob);

  const r = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || "audio/webm"
    })
  });

  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.text || "";
}

async function chatReply(userText) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.reply || "";
}

async function ttsAudio(text) {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!r.ok) throw new Error(await r.text());
  return await r.arrayBuffer();
}

async function playAudio(buf) {
  const blob = new Blob([buf], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  await a.play();
  a.onended = () => URL.revokeObjectURL(url);
}

// Exporta global (para evitar “undefined”)
window.transcribeAudio = transcribeAudio;
window.chatReply = chatReply;
window.ttsAudio = ttsAudio;
window.playAudio = playAudio;

console.log("✅ voicePipeline ready", {
  transcribeAudio: typeof window.transcribeAudio,
  chatReply: typeof window.chatReply,
  ttsAudio: typeof window.ttsAudio,
  playAudio: typeof window.playAudio
});

