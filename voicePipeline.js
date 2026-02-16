// voicePipeline.js
// Front: STT (multipart/form-data) -> CHAT (JSON) -> TTS (JSON->audio) -> play

(function(){
  function emit(name, detail){ window.dispatchEvent(new CustomEvent(name, { detail })); }

  async function VX_transcribeAudio(blob){
    if(!blob || blob.size < 2000) throw new Error("Audio muy corto. Habla 1–2s.");
    // STT espera multipart/form-data
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");

    const r = await fetch("/api/stt", { method:"POST", body: fd });
    const txt = await r.text();

    let j;
    try { j = JSON.parse(txt); } catch { throw new Error(`STT no devolvió JSON: ${txt.slice(0,120)}`); }
    if(!r.ok) throw new Error(j?.error || "STT error");
    return (j.text || "").trim();
  }

  async function VX_chatReply(userText){
    const clean = (userText || "").trim();
    if(!clean) throw new Error("Texto vacío");
    const r = await fetch("/api/chat", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userText: clean })
    });
    const j = await r.json().catch(()=> ({}));
    if(!r.ok) throw new Error(j?.error || "CHAT error");
    return (j.reply || "").trim();
  }

  async function VX_ttsSpeak(text){
    const clean = (text || "").trim();
    if(!clean) return;

    emit("VX_AVATAR", { state:"speaking" });

    const r = await fetch("/api/tts", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text: clean })
    });

    if(!r.ok){
      const t = await r.text().catch(()=> "");
      throw new Error("TTS error: " + t.slice(0,160));
    }
    const buf = await r.arrayBuffer();
    await VX_playAudio(buf);
  }

  async function VX_playAudio(buf){
    // Reproductor simple (Audio tag)
    const blob = new Blob([buf], { type:"audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.preload = "auto";

    // intentar reproducir (si el navegador bloquea autoplay, debes iniciar con click)
    await a.play().catch(()=>{ /* bloqueado */ });

    await new Promise((res)=>{ a.onended = res; a.onerror = res; });
    URL.revokeObjectURL(url);

    emit("VX_AVATAR", { state:"idle" });
  }

  // Export to window
  window.VX_transcribeAudio = VX_transcribeAudio;
  window.VX_chatReply = VX_chatReply;
  window.VX_ttsSpeak = VX_ttsSpeak;
  window.VX_playAudio = VX_playAudio;

  console.log("✅ voicePipeline loaded", {
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_chatReply: typeof window.VX_chatReply,
    VX_ttsSpeak: typeof window.VX_ttsSpeak
  });
})();









