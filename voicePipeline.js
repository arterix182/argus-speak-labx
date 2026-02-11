// voicePipeline.js (COMPLETO)
// Provee: window.VX_transcribeAudio, window.VX_chatReply, window.VX_ttsAudio, window.VX_playAudio

async function VX_transcribeAudio(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.webm");
  const r = await fetch("/api/stt", { method: "POST", body: fd });

  let j;
  try { j = await r.json(); }
  catch { j = { error: "Non-JSON response from /api/stt" }; }

  if (!r.ok) throw new Error(JSON.stringify(j));
  return (j.text || "").trim();
}

async function VX_chatReply(userText) {
  const clean = (userText || "").trim();
  if (!clean) throw new Error("Empty userText");
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText: clean })
  });

  let j;
  try { j = await r.json(); }
  catch { j = { error: "Non-JSON response from /api/chat" }; }

  if (!r.ok) throw new Error(JSON.stringify(j));
  return (j.reply || "").trim();
}

async function VX_ttsAudio(text) {
  const clean = (text || "").trim();
  if (!clean) throw new Error("Empty text");

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean })
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

window.VX_transcribeAudio = VX_transcribeAudio;
window.VX_chatReply = VX_chatReply;
window.VX_ttsAudio = VX_ttsAudio;
window.VX_playAudio = VX_playAudio;

console.log("✅ voicePipeline loaded", {
  VX_transcribeAudio: typeof window.VX_transcribeAudio,
  VX_chatReply: typeof window.VX_chatReply,
  VX_ttsAudio: typeof window.VX_ttsAudio
});



