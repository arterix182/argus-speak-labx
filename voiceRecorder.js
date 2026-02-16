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

  // ✅ Ajustes de silencio (REDUCEN la espera post-habla)
  // Antes: 800ms (muy alto). Ahora: 420ms (se siente “inmediato” sin cortar palabras).
  let SILENCE_HOLD_MS = 420;      // silencio necesario para cortar
  let START_THRESHOLD = 0.020;    // umbral para “ya está hablando”
  let SILENCE_THRESHOLD = 0.012;  // umbral para considerar silencio

  // ✅ detector más rápido
  const SILENCE_TICK_MS = 50;     // antes 80ms

  // ✅ chunks más frecuentes (mejor “flush” al final)
  const TIMESLICE_MS = 250;       // antes 200ms

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

  // ✅ Cuando detecta silencio sostenido, hace requestData() y luego stop()
  function detectSilenceAndStop(getRms){
    let startedTalking = false;
    let silenceSince = null;

    return new Promise((resolve)=>{
      const t = setInterval(()=>{
        if(!callActive || !mediaRecorder) { clearInterval(t); return resolve("stopped"); }
        const rms = getRms();

        if(!startedTalking){
          if(rms >= START_THRESHOLD){
            startedTalking = true;
            silenceSince = null;
          }
          return;
        }

        if(rms < SILENCE_THRESHOLD){
          if(silenceSince == null) silenceSince = Date.now();
          if(Date.now() - silenceSince >= SILENCE_HOLD_MS){
            clearInterval(t);

            // ✅ FLUSH: fuerza el último chunk ANTES de parar
            try{ if(mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.requestData(); }catch{}

            // pequeño delay para que el chunk “caiga” (reduce blobs vacíos)
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

  async function recordOneTurn(){
    if(!callActive) return;
    if(busyTurn) return;
    busyTurn = true;

    emitState("listening");

    const chunks = [];

    // ✅ escoger mimeType soportado (evita blobs vacíos en algunos devices)
    const preferred = ["audio/webm;codecs=opus", "audio/webm"];
    const mimeType = preferred.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });

    const done = new Promise((resolve, reject)=>{
      mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onerror = (e)=> reject(e?.error || e);
      mediaRecorder.onstop = ()=> resolve();
    });

    mediaRecorder.start(TIMESLICE_MS);

    // auto-stop por silencio
    await detectSilenceAndStop(getRmsNow);
    await done;

    const blob = new Blob(chunks, { type: mimeType });

    try{
      emitState("thinking");

      // ✅ micro-feedback instantáneo: al menos “reacciona” ya
      // (si no lo quieres, bórralo)
      // onBotText("…");

      // STT
      const userText = await window.VX_transcribeAudio(blob);
      onUserText(userText);

      // CHAT
      const reply = await window.VX_chatReply(userText);
      onBotText(reply);

      // TTS
      emitState("speaking");
      await window.VX_ttsSpeak(reply);

      emitState("idle");
    }catch(err){
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
        await new Promise(r=>setTimeout(r, 80)); // antes 120
      }catch(e){
        console.error(e);
        if(typeof onBotText === "function") onBotText("⚠️ Error: " + (e?.message || e));
        await new Promise(r=>setTimeout(r, 250)); // antes 350
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

    callActive = true;

    await openMic();

    // refresca mics ya con permiso (labels correctos)
    try{ await VX_refreshMics(); }catch{}

    // ✅ evita cold start
    warmUpApis();

    loopTurns(); // no await
  }

  async function VX_callStop(){
    callActive = false;
    busyTurn = false;

    try{
      if(mediaRecorder && mediaRecorder.state === "recording"){
        // ✅ flush final si paras manualmente
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



