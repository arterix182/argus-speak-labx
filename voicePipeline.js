// voicePipeline.js — STT (multipart) -> CHAT -> TTS -> play

(() => {
  const log = (s) => window.__voiceLog?.("SYS", s);

  async function VX_transcribeAudio(blob){
    // STT = multipart/form-data con file
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");

    const r = await fetch("/api/stt", { method:"POST", body: fd });
    let j;
    try { j = await r.json(); }
    catch { throw new Error(JSON.stringify({ error:"Non-JSON response from /api/stt" })); }

    if (!r.ok) throw new Error(JSON.stringify(j));
    return (j.text || "").trim();
  }

  async function VX_chatReply(userText){
    const clean = (userText || "").trim();
    if (!clean) throw new Error("Empty userText");

    const mode = (window.VX_mode || "coach").trim();

    const r = await fetch("/api/chat", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userText: clean, mode })
    });

    let j;
    try { j = await r.json(); }
    catch { throw new Error(JSON.stringify({ error:"Non-JSON response from /api/chat" })); }

    if (!r.ok) throw new Error(JSON.stringify(j));
    return (j.reply || "").trim();
  }

  async function VX_ttsAudio(text){
    const clean = (text || "").trim();
    if (!clean) throw new Error("Empty text");

    const r = await fetch("/api/tts", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text: clean })
    });

    if (!r.ok) {
      const t = await r.text().catch(()=> "");
      throw new Error(t || "TTS failed");
    }
    return await r.arrayBuffer();
  }

  async function VX_playAudio(buf){
    // Reproduce audio mp3/mpeg
    const blob = new Blob([buf], { type:"audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    await a.play();
    a.onended = () => URL.revokeObjectURL(url);
  }

  window.VX_transcribeAudio = VX_transcribeAudio;
  window.VX_chatReply = VX_chatReply;
  window.VX_ttsAudio = VX_ttsAudio;
  window.VX_playAudio = VX_playAudio;

  console.log("✅ voicePipeline loaded");
  log?.("✅ voicePipeline listo.");
})();


