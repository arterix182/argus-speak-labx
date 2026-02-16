/* voiceRecorder.js (DEFAULT MIC + LEVEL METER + MIC TEST)
   - Siempre usa mic default: getUserMedia({audio:true})
   - Expone:
       VX_callStart()
       VX_callStop()
       VX_micTest3s()  -> graba 3s y reproduce (debug)
   - Callbacks opcionales:
       VX_onLog(msg)
       VX_onState(state)  // idle/listening
       VX_onLevel(pct)    // 0..1 para medidor
*/

(() => {
  "use strict";

  const S = {
    stream: null,
    mediaRecorder: null,
    chunks: [],
    isRecording: false,

    // Meter
    audioCtx: null,
    analyser: null,
    meterRAF: 0,
    sourceNode: null,
    lastLevel: 0,
  };

  function log(msg){
    console.log("[VX]", msg);
    if (typeof window.VX_onLog === "function") window.VX_onLog(msg);
  }

  async function setState(st){
    if (typeof window.VX_onState === "function") {
      try { await window.VX_onState(st); } catch {}
    }
  }

  function pushLevel(p){
    S.lastLevel = p;
    if (typeof window.VX_onLevel === "function") {
      try { window.VX_onLevel(p); } catch {}
    }
  }

  function pickMime(){
    const list = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];
    for (const m of list){
      if (window.MediaRecorder?.isTypeSupported?.(m)) return { mimeType: m };
    }
    return {};
  }

  function makeRecorder(stream){
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder no soportado en este navegador.");
    }
    const mr = new MediaRecorder(stream, pickMime());
    S.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) S.chunks.push(e.data);
    };
    mr.onerror = (e) => log("SYS: MediaRecorder ERROR: " + (e?.error?.message || e?.message || e));

    return mr;
  }

  function blobFromChunks(){
    if (!S.chunks.length) return null;
    const type = S.mediaRecorder?.mimeType || "audio/webm";
    return new Blob(S.chunks, { type });
  }

  async function stopAll(){
    // Stop recorder
    try {
      if (S.mediaRecorder && S.mediaRecorder.state !== "inactive") {
        S.mediaRecorder.stop();
      }
    } catch {}
    S.mediaRecorder = null;
    S.isRecording = false;

    // Stop meter
    stopMeter();

    // Stop stream
    if (S.stream){
      try { S.stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    S.stream = null;
  }

  async function getStreamDefault(){
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia() no disponible.");
    }
    // ✅ default mic
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  }

  function startMeter(stream){
    stopMeter();

    // WebAudio meter (real)
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      log("SYS: AudioContext no disponible (sin medidor).");
      return;
    }

    S.audioCtx = new AC();
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 512;

    S.sourceNode = S.audioCtx.createMediaStreamSource(stream);
    S.sourceNode.connect(S.analyser);

    const data = new Uint8Array(S.analyser.frequencyBinCount);

    const tick = () => {
      try{
        S.analyser.getByteTimeDomainData(data);
        // RMS
        let sum = 0;
        for (let i=0;i<data.length;i++){
          const v = (data[i] - 128) / 128;
          sum += v*v;
        }
        const rms = Math.sqrt(sum / data.length); // 0..~1
        // Escala agradable
        const level = Math.min(1, rms * 2.5);
        pushLevel(level);
      }catch{}
      S.meterRAF = requestAnimationFrame(tick);
    };
    S.meterRAF = requestAnimationFrame(tick);

    log("SYS: Medidor de nivel iniciado ✅");
  }

  function stopMeter(){
    if (S.meterRAF) cancelAnimationFrame(S.meterRAF);
    S.meterRAF = 0;
    pushLevel(0);

    try { S.sourceNode?.disconnect(); } catch {}
    S.sourceNode = null;

    try { S.analyser?.disconnect(); } catch {}
    S.analyser = null;

    if (S.audioCtx){
      try { S.audioCtx.close(); } catch {}
    }
    S.audioCtx = null;
  }

  // Audio unlock (para autoplay policy)
  window.VX_unlockAudio = async function(){
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.01);
      await ctx.close();
    }catch{}
  };

  // Grabación normal
  window.VX_callStart = async function(){
    try{
      log("SYS: VX_callStart (default mic)");
      await setState("listening");

      await stopAll();
      S.stream = await getStreamDefault();

      // 🔥 Si el track viene disabled, lo habilitamos
      const track = S.stream.getAudioTracks()[0];
      if (track) track.enabled = true;

      startMeter(S.stream);

      S.mediaRecorder = makeRecorder(S.stream);
      S.mediaRecorder.start(250);
      S.isRecording = true;

      log("SYS: Grabación iniciada ✅");
      return { ok:true, mimeType: S.mediaRecorder.mimeType };
    }catch(e){
      log("SYS: ERROR VX_callStart: " + (e?.name ? `${e.name}: ` : "") + (e?.message || e));
      await stopAll();
      await setState("idle");
      throw e;
    }
  };

  window.VX_callStop = async function(){
    try{
      log("SYS: VX_callStop");
      if (!S.mediaRecorder){
        await stopAll();
        await setState("idle");
        return { ok:true, blob:null, mimeType:null };
      }

      const mr = S.mediaRecorder;
      const stopped = new Promise((res) => { mr.onstop = () => res(true); });

      if (mr.state !== "inactive") mr.stop();
      await stopped;

      const blob = blobFromChunks();
      const mimeType = mr.mimeType || (blob ? blob.type : null);

      await stopAll();
      await setState("idle");

      log("SYS: Grabación detenida ✅ chunks=" + (S.chunks?.length || 0));
      return { ok:true, blob, mimeType };
    }catch(e){
      log("SYS: ERROR VX_callStop: " + (e?.message || e));
      await stopAll();
      await setState("idle");
      return { ok:false, error: e?.message || String(e) };
    }
  };

  // ✅ PRUEBA INFALIBLE: graba 3s y reproduce
  window.VX_micTest3s = async function(){
    log("SYS: MicTest 3s...");
    await window.VX_callStart();

    await new Promise(r => setTimeout(r, 3000));

    const r = await window.VX_callStop();
    if (!r.ok || !r.blob || r.blob.size < 2000){
      throw new Error("No se grabó audio (blob vacío o muy pequeño).");
    }

    const url = URL.createObjectURL(r.blob);
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
    log("SYS: MicTest reproducido ✅");
    return { ok:true, size:r.blob.size, type:r.blob.type };
  };

  // Ya no usamos selección de mic
  window.VX_refreshMics = async () => ({ ok:true, mics:[] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js listo ✅ (default mic + meter + test)");
})();

