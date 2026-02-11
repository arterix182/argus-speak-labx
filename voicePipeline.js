// voicePipeline.js (COMPLETO) — VX_* para evitar choques con código viejo

// ===============================
// STT (multipart/form-data)
// Tu function /api/stt exige multipart/form-data o x-www-form-urlencoded,
// por eso aquí mandamos FormData (sin headers Content-Type).
// ===============================
async function VX_transcribeAudio(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.webm"); // <-- nombre de campo típico
  fd.append("mimeType", blob.type || "audio/webm"); // por si tu backend lo usa

  const r = await fetch("/api/stt", {
    method: "POST",
    body: fd, // IMPORTANTE: sin headers para que el browser ponga boundary correcto
  });

  let j;
  try { j = await r.json(); } catch { j = { error: "Non-JSON response from /api/stt" }; }
  if (!r.ok) throw new Error(JSON.stringify(j));

  return (j.text || "").trim();
}

// ===============================
// CHAT -> /api/chat (JSON)
// Espera { userText } y responde { reply }
// ===============================
async function VX_chatReply(userText) {
  const clean = (userText || "").trim();
  if (!clean) throw new Error("Empty userText");

  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText: clean }),
  });

  let j;
  try { j = await r.json(); } catch { j = { error: "Non-JSON response from /api/chat" }; }
  if (!r.ok) throw new Error(JSON.stringify(j));

  return (j.reply || "").trim();
}

// ===============================
// TTS -> /api/tts (JSON)  (si existe)
// Responde audio (arrayBuffer). Si no existe, fallará y el recorder lo ignora.
// ===============================
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

async function VX_playAudio(buf) {
  const blob = new Blob([buf], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  await a.play();
  a.onended = () => URL.revokeObjectURL(url);
}

// ===============================
// Exports a window (blindado)
// ===============================
window.VX_transcribeAudio = VX_transcribeAudio;
window.VX_chatReply = VX_chatReply;
window.VX_ttsAudio = VX_ttsAudio;
window.VX_playAudio = VX_playAudio;

console.log("✅ voicePipeline loaded (VX)", {
  VX_transcribeAudio: typeof window.VX_transcribeAudio,
  VX_chatReply: typeof window.VX_chatReply,
  VX_ttsAudio: typeof window.VX_ttsAudio,
  VX_playAudio: typeof window.VX_playAudio
});




