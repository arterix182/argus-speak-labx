// voiceRecorder.js
// Conversación continua: getUserMedia -> MediaRecorder -> auto-stop por silencio -> pipeline -> vuelve a escuchar
(function(){
  function emitState(state){ window.dispatchEvent(new CustomEvent("VX_STATE",{detail:{state}})); window.dispatchEvent(new CustomEvent("VX_AVATAR",{detail:{state}})); }

  let selectedDeviceId = "";
  let stream = null;
  let mediaRecorder = null;

  let audioCtx = null;
  let analyser = null;
  let data = null;
  let rafId = null;

  let callActive = false;
  let busyTurn = false;

  // Ajustes: silencio
  let SILENCE_HOLD_MS = 800;      // silencio necesario para cortar
  let START_THRESHOLD = 0.020;    // umbral para “ya está hablando”
  let SILENCE_THRESHOLD = 0.012;  // umbral para considerar silencio

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
    // Enumerate sin permisos puede devolver labels vacíos; con permiso salen completos.
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

    // Esto pide permiso y “activa” el mic (necesario para que salga bien la lista)
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
            try{ mediaRecorder.stop(); }catch{}
            resolve("silence");
          }
        } else {
          silenceSince = null;
        }
      }, 80);
    });
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

  async function recordOneTurn(){
    if(!callActive) return;
    if(busyTurn) return;
    busyTurn = true;

    emitState("listening");

    // MediaRecorder
    const chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

    const done = new Promise((resolve, reject)=>{
      mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onerror = (e)=> reject(e?.error || e);
      mediaRecorder.onstop = ()=> resolve();
    });

    mediaRecorder.start(200); // timeslice

    // auto-stop por silencio
    await detectSilenceAndStop(getRmsNow);
    await done;

    const blob = new Blob(chunks, { type:"audio/webm" });

    try{
      emitState("thinking");
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
        // mini pausa para que el navegador respire
        await new Promise(r=>setTimeout(r, 120));
      }catch(e){
        // si falla STT/CHAT/TTS, seguimos escuchando (no matamos la llamada)
        console.error(e);
        if(typeof onBotText === "function") onBotText("⚠️ Error: " + (e?.message || e));
        await new Promise(r=>setTimeout(r, 350));
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

    // abrir mic y arrancar loop
    await openMic();

    // refresca mics ya con permiso (labels correctos)
    try{ await VX_refreshMics(); }catch{}

    loopTurns(); // no await
  }

  async function VX_callStop(){
    callActive = false;
    busyTurn = false;
    try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}
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
    VX_refreshMics: typeof window.VX_refreshMics
  });
})();










