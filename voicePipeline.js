// voicePipeline.js

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
  return j.text;
  // Asegura que las funciones queden globales
window.transcribeAudio = transcribeAudio;
window.chatReply = chatReply;
window.ttsAudio = ttsAudio;
window.playAudio = playAudio;

}

