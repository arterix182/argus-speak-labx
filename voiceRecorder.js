(function(){
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let micId = "default";
  let callRunning = false;

  let vadCtx = null;
  let analyser = null;
  let vadData = null;
  let vadRAF = null;

  function ui(){ return window.VX_UI || {}; }
  function addLog(x){ ui().addLog && ui().addLog(x); }
  function setState(s, label){ ui().setState && ui().setState(s, label); }
  function setMeter(p){ ui().setMeter && ui().setMeter(p); }

  async function VX_refreshMics(){
    addLog("SYS: Actualizando micrófonos...");

    const sel = document.querySelector("#selMic");
    if(!sel) return;

    // En algunos navegadores, labels solo aparecen tras permiso.
    // Pedimos permiso aquí de forma segura.
    try{
      const tmp = await navigator.mediaDevices.getUserMedia({ audio:true });
      tmp.getTracks().forEach(t=>t.stop());
    }catch(e){
      addLog("SYS: Permiso mic no concedido aún (ok).");
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");

    sel.innerHTML = "";
    for(const d of mics){
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || ("Mic " + d.deviceId.slice(0,6));
      sel.appendChild(opt);
    }

    const saved = localStorage.getItem("VX_MIC");
    if(saved && [...sel.options].some(o=>o.value===saved)){
      sel.value = saved;
      micId = saved;
    }else if(sel.options.length){
      micId = sel.value;
    }

    sel.onchange = ()=>{
      micId = sel.value;
      localStorage.setItem("VX_MIC", micId);
      addLog("SYS: Mic seleccionado = " + micId);
    };

    addLog("SYS: Mics encontrados = " + mics.length);
  }

  function stopTracks(){
    try{ if(stream) stream.getTracks().forEach(t=>t.stop()); }catch{}
    stream = null;
  }

  function teardownVAD(){
    try{ if(vadRAF) cancelAnimationFrame(vadRAF); }catch{}
    vadRAF = null;
    analyser = null;
    vadData = null;
    try{ if(vadCtx) vadCtx.close(); }catch{}
    vadCtx = null;
  }

  async function startStream(){
    stopTracks();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: micId && micId!=="default"
        ? { deviceId: { exact: micId }, echoCancellation:true, noiseSuppression:true, autoGainControl:true }
        : { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    return stream;
  }

  function setupVAD(){
    teardownVAD();
    vadCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = vadCtx.createMediaStreamSource(stream);
    analyser = vadCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    vadData = new Uint8Array(analyser.frequencyBinCount);
  }

  function getRms(){
    analyser.getByteTimeDomainData(vadData);
    let sum=0;
    for(let i=0;i<vadData.length;i++){
      const v = (vadData[i]-128)/128;
      sum += v*v;
    }
    return Math.sqrt(sum/vadData.length);
  }

  async function recordOneTurn(){
    chunks = [];
    await startStream();
    setupVAD();

    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };

    const STOP_SILENCE_MS = 700;
    const CAL_MS = 300;
    const MAX_MS = 12000;

    let startedVoice = false;
    let tStart = performance.now();
    let tVoice = performance.now();
    let noiseFloor = 0.01;

    const tCalStart = performance.now();
    let calCount=0, calSum=0;

    mediaRecorder.start(100);

    setState("listening","Escuchando...");
    addLog("SYS: Escuchando... (auto-stop por silencio)");

    return await new Promise((resolve, reject)=>{
      const stopNow = ()=>{
        try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}
      };

      mediaRecorder.onstop = ()=>{
        teardownVAD();
        stopTracks();
        const blob = new Blob(chunks, { type:"audio/webm" });
        resolve(blob);
      };

      mediaRecorder.onerror = (e)=>{ teardownVAD(); stopTracks(); reject(e.error || e); };

      const tick = ()=>{
        try{
          const rms = getRms();
          const pct = Math.min(100, Math.max(0, (rms * 2800)));
          setMeter(pct);

          if(performance.now() - tCalStart < CAL_MS){
            calSum += rms; calCount++;
            noiseFloor = (calSum / Math.max(1,calCount)) * 1.6;
          }else{
            const startThresh = Math.max(0.012, noiseFloor * 1.8);
            const silenceThresh = Math.max(0.008, noiseFloor * 1.2);

            if(!startedVoice && rms > startThresh){
              startedVoice = true;
              tVoice = performance.now();
              addLog(`SYS: Calibrado. ruido=${noiseFloor.toFixed(3)} start=${startThresh.toFixed(3)} silence=${silenceThresh.toFixed(3)}`);
            }

            if(startedVoice){
              if(rms < silenceThresh){
                if(performance.now() - tVoice > STOP_SILENCE_MS){
                  addLog("SYS: Auto-stop por silencio.");
                  stopNow(); return;
                }
              }else{
                tVoice = performance.now();
              }
            }

            if(performance.now() - tStart > MAX_MS){
              addLog("SYS: Stop por tiempo máximo.");
              stopNow(); return;
            }
          }

          vadRAF = requestAnimationFrame(tick);
        }catch(err){
          reject(err);
        }
      };
      tick();
    });
  }

  async function runLoop(mode){
    while(callRunning){
      setState("listening","Escuchando...");
      addLog("SYS: STT...");
      const blob = await recordOneTurn();
      if(!callRunning) break;

      const text = await window.VX_transcribeAudio(blob);
      if(!text){
        addLog("SYS: Habla al menos 1 segundo. Intenta de nuevo.");
        continue;
      }
      addLog("YOU: " + text);

      setState("thinking","Procesando...");
      addLog("SYS: CHAT...");
      const reply = await window.VX_chat(text, mode);
      addLog("BOT: " + reply);

      setState("speaking","Hablando...");
      addLog("SYS: TTS...");
      await window.VX_ttsSpeak(reply);

      setState("idle","idle");
    }
  }

  async function VX_callStart({ selMicEl, modeEl }){
    if(callRunning) return;

    if(selMicEl && selMicEl.value) micId = selMicEl.value;
    localStorage.setItem("VX_MIC", micId);

    callRunning = true;
    addLog("SYS: 📞 Llamada iniciada.");
    setState("listening","listening");

    if(typeof window.VX_transcribeAudio !== "function") throw new Error("VX_transcribeAudio missing");
    if(typeof window.VX_chat !== "function") throw new Error("VX_chat missing");
    if(typeof window.VX_ttsSpeak !== "function") throw new Error("VX_ttsSpeak missing");

    const mode = (modeEl && modeEl.value) ? modeEl.value : "coach";
    runLoop(mode).catch(e=>{
      addLog("SYS: ERROR: " + (e?.message||e));
      setState("idle","error");
      callRunning = false;
      ui().setCallUI && ui().setCallUI(false);
    });
  }

  async function VX_callStop(){
    callRunning = false;
    try{ if(mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }catch{}
    teardownVAD();
    stopTracks();
    setMeter(0);
  }

  window.VX_refreshMics = VX_refreshMics;
  window.VX_callStart = VX_callStart;
  window.VX_callStop = VX_callStop;

  console.log("✅ voiceRecorder loaded", {
    VX_callStart: typeof window.VX_callStart,
    VX_callStop: typeof window.VX_callStop,
    VX_refreshMics: typeof window.VX_refreshMics
  });
})();












