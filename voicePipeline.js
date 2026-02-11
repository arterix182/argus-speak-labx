// voicePipeline.js

async function transcribeAudio(blob) {
  const fd = new FormData();
  fd.append("file", blob, "audio.webm");

  const r = await fetch("/api/stt", { method: "POST", body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.text;
}

async function chatReply(userText) {
  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userText })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.reply;
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


