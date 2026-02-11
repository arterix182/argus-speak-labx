// voicePipeline.js (COMPLETO v4)
// Endpoints esperados:
//   POST /api/stt  -> devuelve JSON { text: "..." }
//   POST /api/chat -> devuelve JSON { reply: "..." }
//   POST /api/tts  -> devuelve audio/mpeg (o similar)

async function VX_blobToBase64(blob){
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = "";
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function VX_transcribeAudio(blob){
  const audioBase64 = await VX_blobToBase64(blob);
  const r = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || "audio/webm"
    })
  });

  let j;
  try{ j = await r.json(); }catch(e){ j = { error: "Non-JSON response from /api/stt" }; }
  if(!r.ok) throw new Error(JSON.stringify(j));
  return (j.text || "").trim();
}

async function VX_chatReply(userText){
  const clean = (userText || "").trim();
  if(!clean) throw new Error("Empty userText");

  const r = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ userText: clean })
  });

  let j;
  try{ j = await r.json(); }catch(e){ j = { error: "Non-JSON response from /api/chat" }; }
  if(!r.ok) throw new Error(JSON.stringify(j));
  return (j.reply || "").trim();
}

async function VX_ttsAudio(text){
  const clean = (text || "").trim();
  if(!clean) throw new Error("Empty text");

  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ text: clean })
  });

  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(t || "TTS request failed");
  }
  return await r.arrayBuffer();
}

let VX_currentAudio = null;

async function VX_playAudio(buf){
  // Corta audio previo
  try{
    if(VX_currentAudio){
      VX_currentAudio.pause();
      VX_currentAudio.src = "";
      VX_currentAudio = null;
    }
  }catch(e){}

  const blob = new Blob([buf], { type:"audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  VX_currentAudio = a;

  return new Promise((resolve, reject)=>{
    a.onended = ()=>{
      try{ URL.revokeObjectURL(url); }catch(e){}
      if(VX_currentAudio === a) VX_currentAudio = null;
      resolve();
    };
    a.onerror = (e)=>{
      try{ URL.revokeObjectURL(url); }catch(_){}
      if(VX_currentAudio === a) VX_currentAudio = null;
      reject(new Error("Audio play error"));
    };
    a.play().catch(err=>{
      try{ URL.revokeObjectURL(url); }catch(_){}
      if(VX_currentAudio === a) VX_currentAudio = null;
      reject(err);
    });
  });
}

// Expose
window.VX_transcribeAudio = VX_transcribeAudio;
window.VX_chatReply = VX_chatReply;
window.VX_ttsAudio = VX_ttsAudio;
window.VX_playAudio = VX_playAudio;

console.log("✅ voicePipeline loaded", {
  VX_transcribeAudio: typeof window.VX_transcribeAudio,
  VX_chatReply: typeof window.VX_chatReply,
  VX_ttsAudio: typeof window.VX_ttsAudio
});
