// voiceRecorder.js
// Conversación continua: getUserMedia -> MediaRecorder -> auto-stop por silencio -> pipeline -> vuelve a escuchar
(function(){
  function emitState(state){
    window.dispatchEvent(new CustomEvent("VX_STATE",{detail:{state}}));
    window.dispatchEvent(new CustomEvent("VX_AVATAR",{detail:{state}}));
  }

  let selectedDeviceId = "";
  let stream = null;
  let mediaRecorder = null;

  let audioCtx = null;
  let analyser = null;
  let data = null;
  let rafId = null;

  let callActive = false;
  let busyTurn = false;

  // ✅ Memoria de conversación (para que "siga" el hilo)
  let history = [];

  // ✅ Ajustes de silencio (se auto-ajustan por ruido ambiente)
  // Si tu planta/ambiente tiene ruido, un umbral fijo puede tardar mucho en detectar silencio.
  let SILENCE_HOLD_MS = 260;      // silencio necesario para cortar (más rápido)
  let START_THRESHOLD = 0.020;    // base; luego se ajusta por calibración
  let SILENCE_THRESHOLD = 0.012;  // base; luego se ajusta por calibración

  // ✅ detector más rápido
  const SILENCE_TICK_MS = 40;

  // ✅ chunks más frecuentes
  const TIMESLICE_MS = 250;

  // ✅ keep-alive (evita cold start durante llamada)
  let keepAliveTimer = null;

  // callbacks desde index
  let onUserText = ()=>{};
  let onBotText = ()=>{};

  function stopTracks(){
    if(stream){
      stream.getTracks().forEach(t=> t.stop());
      stream = null;
    }
  }

  async function ensureAudioContext(){
    if(!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if(audioCtx.state === "suspended"){
      try{ await audioCtx.resume(); }catch{}
    }
  }

  function levelLoop(){
    if(!analyser) return;
    analyser.getByteTimeDomainData(data);
    // RMS
    let sum = 0;
    for(let i=0;i<data.length;i++){
      const v = (data[i]-128)/128;
      sum += v*v;
    }
    const rms = Math.sqrt(sum/data.length);
    if(typeof window.VX_onLevel === "function") window.VX_onLevel(rms);
    rafId = requestAnimationFrame(levelLoop);
  }

  async function VX_refreshMics(){
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d=> d.kind==="audioinput").map(d=>({ deviceId:d.deviceId, label:d.label }));
  }

  function VX_setMic(deviceId){
    selectedDeviceId = deviceId || "";
  }

  async function openMic(){
    stopTracks();
    await ensureAudioContext();

    const constraints = {
      audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Analyser para nivel
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    data = new Uint8Array(analyser.fftSize);
    src.connect(analyser);

    if(rafId) cancelAnimationFrame(rafId);
    levelLoop();
  }

  function getRmsNow(){
    if(!analyser) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for(let i=0;i<data.length;i++){
      const v = (data[i]-128)/128;
      sum += v*v;
    }
    return Math.sqrt(sum/data.length);
  }

  async function calibrateNoiseFloor(ms = 320){
    // Toma una muestra rápida del ruido ambiente para ajustar thresholds.
    const t0 = Date.now();
    const samples = [];
    while(Date.now() - t0 < ms){
      samples.push(getRmsNow());
      await new Promise(r=>setTimeout(r, 40));
    }
    if(!samples.length) return 0.010;
    const avg = samples.reduce((a,b)=>a+b,0)/samples.length;
    return Math.max(0.006, Math.min(avg, 0.060));
  }

  function detectSilenceAndStop(getRms, th){
    let startedTalking = false;
    let silenceSince = null;

    const startTh   = th?.start ?? START_THRESHOLD;
    const silenceTh = th?.silence ?? SILENCE_THRESHOLD;
    const maxTalkMs = th?.maxTalkMs ?? 9000;   // evita “me quedé hablando y nunca corta”
    const maxTurnMs = th?.maxTurnMs ?? 12000;  // tope duro
    const turnStart = Date.now();
    let talkStart = null;

    return new Promise((resolve)=>{
      const t = setInterval(()=>{
        if(!callActive || !mediaRecorder) { clearInterval(t); return resolve("stopped"); }
        const rms = getRms();

        // Tope duro del turno (por si el mic está raro o el ruido no deja cortar)
        if(Date.now() - turnStart > maxTurnMs){
          clearInterval(t);
          try{ if(mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.requestData(); }catch{}
          setTimeout(()=>{ try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}; resolve("max"); }, 20);
          return;
        }

        if(!startedTalking){
          if(rms >= startTh){
            startedTalking = true;
            talkStart = Date.now();
            silenceSince = null;
          }
          return;
        }

        // Si ya empezó a hablar, también ponemos tope por “habla continua”
        if(talkStart && (Date.now() - talkStart > maxTalkMs)){
          clearInterval(t);
          try{ if(mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.requestData(); }catch{}
          setTimeout(()=>{ try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}; resolve("maxtalk"); }, 20);
          return;
        }

        if(rms < silenceTh){
          if(silenceSince == null) silenceSince = Date.now();
          if(Date.now() - silenceSince >= SILENCE_HOLD_MS){
            clearInterval(t);

            // ✅ FLUSH: fuerza el último chunk ANTES de parar
            try{ if(mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.requestData(); }catch{}

            setTimeout(()=>{
              try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}
              resolve("silence");
            }, 30);
          }
        } else {
          silenceSince = null;
        }
      }, SILENCE_TICK_MS);
    });
  }

  // ✅ Warm-up para evitar cold start (no rompe nada si falla)
  async function warmUpApis(){
    try { fetch("/api/stt", { method:"GET", cache:"no-store" }).catch(()=>{}); } catch {}
    try { fetch("/api/chat", { method:"GET", cache:"no-store" }).catch(()=>{}); } catch {}
    try { fetch("/api/tts", { method:"GET", cache:"no-store" }).catch(()=>{}); } catch {}
  }

  function startKeepAlive(){
    stopKeepAlive();
    // Cada 2 min, mantiene vivas las functions mientras la llamada esté activa
    keepAliveTimer = setInterval(()=>{
      if(!callActive) return;
      warmUpApis();
    }, 120000);
  }

  function stopKeepAlive(){
    try{ if(keepAliveTimer) clearInterval(keepAliveTimer); }catch{}
    keepAliveTimer = null;
  }

  async function recordOneTurn(){
    if(!callActive) return;
    if(busyTurn) return;
    busyTurn = true;

    emitState("listening");

    const chunks = [];

    // ✅ escoger mimeType soportado
    const preferred = ["audio/webm;codecs=opus", "audio/webm"];
    const mimeType = preferred.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    const done = new Promise((resolve, reject)=>{
      mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onerror = (e)=> reject(e?.error || e);
      mediaRecorder.onstop = ()=> resolve();
    });

    mediaRecorder.start(TIMESLICE_MS);

    // ✅ Calibra ruido ambiente justo antes de escuchar (reduce los “10s” por ruido)
    const noise = await calibrateNoiseFloor(280);
    const th = {
      // En ambientes ruidosos sube thresholds automáticamente.
      start:   Math.max(0.018, noise * 2.4),
      silence: Math.max(0.010, noise * 1.6),
      maxTalkMs: 9000,
      maxTurnMs: 12000,
    };

    // auto-stop por silencio
    await detectSilenceAndStop(getRmsNow, th);
    await done;

    const blob = new Blob(chunks, { type: mimeType });

    // ✅ Medición de tiempos (para encontrar los 10 segundos)
    const tAll0 = performance.now();
    const T = { stt: 0, chat: 0, tts: 0, total: 0, blobKb: Math.round((blob.size || 0)/1024) };

    try{
      emitState("thinking");

      // STT
      const tStt0 = performance.now();
      const userText = await window.VX_transcribeAudio(blob);
      T.stt = Math.round(performance.now() - tStt0);
      onUserText(userText);

      // CHAT (con memoria)
      const tChat0 = performance.now();
      const reply = await window.VX_chatReply(userText, { history, mode: "call" });
      // Actualiza memoria desde el backend
      try{
        const m = window.VX_chatLastMemory;
        if(Array.isArray(m) && m.length) history = m.slice(-14);
        else {
          history = [...history, { role:"user", content:userText }, { role:"assistant", content:reply }].slice(-14);
        }
      }catch(_){
        history = [...history, { role:"user", content:userText }, { role:"assistant", content:reply }].slice(-14);
      }
      T.chat = Math.round(performance.now() - tChat0);
      onBotText(reply);

      // TTS
      emitState("speaking");
      const tTts0 = performance.now();
      await window.VX_ttsSpeak(reply);
      T.tts = Math.round(performance.now() - tTts0);

      T.total = Math.round(performance.now() - tAll0);
      console.log("⏱️ TURN ms:", { ...T, chars: (reply || "").length });

      emitState("idle");
    }catch(err){
      T.total = Math.round(performance.now() - tAll0);
      console.log("⏱️ TURN ms (failed):", T);
      emitState("idle");
      throw err;
    }finally{
      busyTurn = false;
    }
  }

  async function loopTurns(){
    while(callActive){
      try{
        await recordOneTurn();
        await new Promise(r=>setTimeout(r, 80));
      }catch(e){
        console.error(e);
        if(typeof onBotText === "function") onBotText("⚠️ Error: " + (e?.message || e));
        await new Promise(r=>setTimeout(r, 250));
      }
    }
  }

  async function VX_callStart(opts={}){
    if(callActive) return;
    onUserText = opts.onUserText || (()=>{});
    onBotText  = opts.onBotText  || (()=>{});

    if(typeof window.VX_transcribeAudio !== "function") throw new Error("Pipeline STT no cargó (VX_transcribeAudio).");
    if(typeof window.VX_chatReply !== "function") throw new Error("Pipeline CHAT no cargó (VX_chatReply).");
    if(typeof window.VX_ttsSpeak !== "function") throw new Error("Pipeline TTS no cargó (VX_ttsSpeak).");

    // Resetea memoria al iniciar llamada (si quieres persistencia entre sesiones, lo guardamos luego)
    history = Array.isArray(opts.historySeed) ? opts.historySeed.slice(-14) : [];
    callActive = true;

    await openMic();

    // refresca mics ya con permiso (labels correctos)
    try{ await VX_refreshMics(); }catch{}

    // ✅ evita cold start
    warmUpApis();
    startKeepAlive();

    loopTurns(); // no await
  }

  async function VX_callStop(){
    callActive = false;
    busyTurn = false;

    stopKeepAlive();

    try{
      if(mediaRecorder && mediaRecorder.state === "recording"){
        try{ mediaRecorder.requestData(); }catch{}
        mediaRecorder.stop();
      }
    }catch{}
    mediaRecorder = null;

    if(rafId) cancelAnimationFrame(rafId);
    rafId = null;

    stopTracks();
    emitState("idle");
  }

  // Export to window
  window.VX_refreshMics = VX_refreshMics;
  window.VX_setMic = VX_setMic;
  window.VX_callStart = VX_callStart;
  window.VX_callStop = VX_callStop;

  console.log("✅ voiceRecorder loaded", {
    VX_callStart: typeof window.VX_callStart,
    VX_refreshMics: typeof window.VX_refreshMics,
    SILENCE_HOLD_MS,
    SILENCE_TICK_MS,
    TIMESLICE_MS
  });
})();



