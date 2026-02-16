(function(){
  async function jsonOrThrow(r){
    const txt = await r.text();
    try { return JSON.parse(txt); }
    catch { throw new Error("Non-JSON response: " + txt.slice(0,120)); }
  }

  async function VX_chat(userText, mode){
    const clean = (userText || "").trim();
    if(!clean) throw new Error("Empty text");
    const r = await fetch("/api/chat", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ userText: clean, mode: mode || "coach" })
    });
    const j = await jsonOrThrow(r);
    if(!r.ok) throw new Error(j.error || "chat failed");
    return (j.reply || "").trim();
  }

  async function VX_transcribeAudio(blob){
    if(!blob || !blob.size) throw new Error("Empty audio blob");
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", blob.type || "audio/webm");

    const r = await fetch("/api/stt", { method:"POST", body: fd });
    const j = await jsonOrThrow(r);
    if(!r.ok) throw new Error(j.error || "stt failed");
    return (j.text || "").trim();
  }

  async function VX_tts(text){
    const clean = (text || "").trim();
    if(!clean) throw new Error("Empty TTS text");
    const r = await fetch("/api/tts", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ text: clean })
    });
    if(!r.ok){
      const j = await jsonOrThrow(r).catch(()=>({error:"tts failed"}));
      throw new Error(j.error || "tts failed");
    }
    return await r.arrayBuffer();
  }

  let audioCtx = null;
  async function VX_ttsSpeak(text){
    if(!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(audioCtx.state === "suspended"){
      try{ await audioCtx.resume(); }catch{}
    }

    const buf = await VX_tts(text);
    const blob = new Blob([buf], { type:"audio/mpeg" });
    const url = URL.createObjectURL(blob);

    const a = new Audio(url);
    a.crossOrigin = "anonymous";

    const src = audioCtx.createMediaElementSource(a);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = null;

    const tick = ()=>{
      analyser.getByteTimeDomainData(data);
      let sum=0;
      for(let i=0;i<data.length;i++){
        const v = (data[i]-128)/128;
        sum += v*v;
      }
      const rms = Math.sqrt(sum/data.length);
      if(window.VX_UI && window.VX_UI.setMouth) window.VX_UI.setMouth(rms*2.2);
      raf = requestAnimationFrame(tick);
    };

    await a.play().catch(()=>{});
    tick();

    await new Promise(res=>{
      a.onended = res;
      a.onerror = res;
    });

    if(raf) cancelAnimationFrame(raf);
    if(window.VX_UI && window.VX_UI.setMouth) window.VX_UI.setMouth(0);
    URL.revokeObjectURL(url);
  }

  window.VX_chat = VX_chat;
  window.VX_transcribeAudio = VX_transcribeAudio;
  window.VX_ttsSpeak = VX_ttsSpeak;

  console.log("✅ voicePipeline loaded", {
    VX_chat: typeof window.VX_chat,
    VX_transcribeAudio: typeof window.VX_transcribeAudio,
    VX_ttsSpeak: typeof window.VX_ttsSpeak
  });
})();










