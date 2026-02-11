// voicePipeline.js (COMPLETO)

// ---- util: blob -> base64 ----
async function blobToBase64(blob) {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---- STT (usa /api/stt) ----
async function transcribeAudio(blob) {
  const audioBase64 = await blobToBase64(blob);

  const r = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || "audio/webm",
    }),
  });

  let j;
  try { j = await r.json(); } catch { j = { error: "Non-JSON response from /api/stt" }; }
  if (!r.ok) throw new Error(JSON.stringify(j));

  return (j.text || "").trim();
}

// ---- CHAT (usa /api/chat) ----
async function chatReply(userText) {
  const clean = (userText || "").trim();
  if (!clean) throw new Error("Empty userText (no speech detected)");

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

// ---- TTS (si ya tienes /api/tts) ----
async function ttsAudio(text) {
  const clean = (text || "").trim();
  if (!clean) throw new Error("Empty text for TTS");

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean }),
  });

  if (!r.ok) throw new Error(await r.text());
  return await r.arrayBuffer();
}

async function playAudio(buf) {
  const blob = new Blob([buf], { type: "audio/mp



