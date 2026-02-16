/* js/voiceRecorder.js
   OBJETIVO: Voz continua sin selector de micro, con logs brutales para debug.
   - Usa SIEMPRE el mic default del dispositivo.
   - VAD: auto-stop por silencio (~0.7s)
   - Loop: escucha -> STT -> chat -> TTS -> reproduce -> repite
   - Si algo falla: NO se muere el loop; loggea y reintenta.
   - Exporta:
       VX_callStart({mode})
       VX_callStop()
       VX_micTest3s()
       VX_unlockAudio()
   Requiere en window:
       VX_sttTranscribe(blob,{mimeType})   (o /api/stt fallback)
       VX_chatReply(text,{mode})
       VX_ttsAudio(text)
       VX_playAudio(arrayBuffer)
*/

(() => {
  "use strict";

  const CFG = {
    silenceMs: 700,
    minVoiceMs: 180,
    recorderTimeslice: 250,
    vadThreshold: 0.015,  // si está “sordo”, baja a 0.010; si está “hipersensible”, sube a 0.020
    vadHangMs: 120,
    turnTimeoutMs: 25000, // evita turnos colgados
    betweenTurnsMs: 180
  };

  const S = {
    running: false,
    stopRequested: false,

    stream: null,
    mr: null,
    chunks: [],

    ac: null,
    analyser: null,
    srcNode: null,
    raf: 0,

    inVoice: false,
    voiceStartedAt: 0,
    lastVoiceAt: 0,
    lastAboveAt: 0,
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(msg){
    console.log("[VX]", msg);
    if (typeof window.VX_onLog === "function") {
      try { window.VX_onLog(msg); } catch {}
    }
  }

  async function setState(st){
    if (typeof window.VX_onState === "function") {
      try { await window.VX_onState(st); } catch {}
    }
  }

  function level(p){
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
    for (const m of list) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return { mimeType: m };
    }
    return {};
  }

  async function getDefaultMic(){
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia() no disponible");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const tr = stream.getAudioTracks?.()[0];
    if (!tr) throw new Error("No se obtuvo audio track");

    tr.enabled = true;
    return stream;
  }

  function makeRecorder(stream){
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder no soportado");
    const mr = new MediaRecorder(stream, pickMime());
    S.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) S.chunks.push(e.data);
    };
    mr.onerror = (e) => log("MediaRecorder ERROR: " + (e?.error?.message || e?.message || e));

    return mr;
  }

  function blobFromChunks(mimeType){
    if (!S.chunks.length) return null;
    return new Blob(S.chunks, { type: mimeType || S.mr?.mimeType || "audio/webm" });
  }

  async function stopStream(){
    if (S.stream) {
      try { S.stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    S.stream = null;
  }

  async function stopAudioGraph(){
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    level(0);

    try { S.srcNode?.disconnect(); } catch {}
    S.srcNode = null;

    try { S.analyser?.disconnect(); } catch {}
    S.analyser = null;

    if (S.ac) {
      try { await S.ac.close(); } catch {}
    }
    S.ac = null;

    // reset VAD
    S.inVoice = false;
    S.voiceStartedAt = 0;
    S.lastVoiceAt = 0;
    S.lastAboveAt = 0;
  }

  async function hardStopAll(){
    try { if (S.mr && S.mr.state !== "inactive") S.mr.stop(); } catch {}
    S.mr = null;
    S.chunks = [];
    await stopAudioGraph();
    await stopStream();
  }

  function startVAD(stream){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log("AudioContext no disponible (sin VAD/meter)"); return; }

    S.ac = new AC();
    S.analyser = S.ac.createAnalyser();
    S.analyser.fftSize = 1024;

    S.srcNode = S.ac.createMediaStreamSource(stream);
    S.srcNode.connect(S.analyser);

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
        const rms = Math.sqrt(sum / data.length);
        const pct = Math.min(1, rms * 2.5);
        level(pct);

        const now = performance.now();
        const above = rms >= CFG.vadThreshold;

        if (above){
          S.lastAboveAt = now;
          if (!S.inVoice){
            S.inVoice = true;
            S.voiceStartedAt = now;
            log("VAD: voz detectada ✅");
          }
          S.lastVoiceAt = now;
        } else {
          if (S.inVoice && (now - S.lastAboveAt) > CFG.vadHangMs) {
            S.inVoice = false;
          }
        }
      }catch{}
      S.raf = requestAnimationFrame(tick);
    };

    S.raf = requestAnimationFrame(tick);
  }

  async function recordUntilSilence(){
    const start = performance.now();

    // 1) esperar voz (o timeout 10s)
    while (!S.stopRequested){
      const now = performance.now();
      if (S.voiceStartedAt && (now - S.voiceStartedAt) >= CFG.minVoiceMs) break;
      if (now - start > 10000) {
        log("SYS: no se detectó voz (timeout 10s).");
        break;
      }
      await sleep(50);
    }

    // 2) esperar silencio
    while (!S.stopRequested){
      const now = performance.now();
      const sinceVoice = S.lastVoiceAt ? (now - S.lastVoiceAt) : 999999;
      if (sinceVoice >= CFG.silenceMs) break;
      await sleep(50);
    }
  }

  async function stopRecorderAndGetBlob(){
    if (!S.mr) return { blob:null, mimeType:null };

    const mr = S.mr;
    const mimeType = mr.mimeType || "audio/webm";
    const stopped = new Promise(res => { mr.onstop = () => res(true); });

    try { if (mr.state !== "inactive") mr.stop(); } catch {}
    await stopped;

    const blob = blobFromChunks(mimeType);
    S.mr = null;

    return { blob, mimeType };
  }

  async function stt(blob, mimeType){
    // Prefer función pipeline
    if (typeof window.VX_sttTranscribe === "function") {
      return await window.VX_sttTranscribe(blob, { mimeType });
    }

    // Fallback /api/stt
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", mimeType || blob.type || "audio/webm");
    const r = await fetch("/api/stt", { method:"POST", body: fd, cache:"no-store" });
    const txt = await r.text();
    let j = {};
    try { j = JSON.parse(txt); } catch { j = { text: txt }; }
    if (!r.ok) throw new Error(j.error || ("STT HTTP " + r.status));
    return (j.text || "").trim();
  }

  async function oneTurn(mode){
    const turnStart = performance.now();

    await setState("listening");
    log("SYS: Turn start (listening)");

    // mic + VAD + recorder
    S.stream = await getDefaultMic();
    startVAD(S.stream);

    S.mr = makeRecorder(S.stream);
    S.mr.start(CFG.recorderTimeslice);
    log("SYS: Grabación iniciada ✅ mime=" + (S.mr.mimeType || "unknown"));

    await recordUntilSilence();

    const { blob, mimeType } = await stopRecorderAndGetBlob();
    await stopAudioGraph();
    await stopStream();

    if (S.stopRequested) {
      log("SYS: stopRequested => abort turn");
      return;
    }

    if (!blob) {
      log("SYS: blob null => nada que transcribir");
      await setState("idle");
      return;
    }

    log("SYS: Audio blob size=" + blob.size + " type=" + (blob.type || mimeType));
    if (blob.size < 1500) {
      log("SYS: Audio muy pequeño (silencio).");
      await setState("idle");
      return;
    }

    await setState("thinking");
    log("SYS: STT...");

    // Timeout de turno
    if ((performance.now() - turnStart) > CFG.turnTimeoutMs) {
      log("SYS: Turn timeout antes de STT.");
      await setState("idle");
      return;
    }

    const text = (await stt(blob, mimeType)).trim();
    log("YOU: " + (text || "(silencio)"));

    if (!text) {
      await setState("idle");
      return;
    }

    if (typeof window.VX_chatReply !== "function") {
      throw new Error("Falta VX_chatReply en pipeline");
    }
    if (typeof window.VX_ttsAudio !== "function") {
      throw new Error("Falta VX_ttsAudio en pipeline");
    }
    if (typeof window.VX_playAudio !== "function") {
      throw new Error("Falta VX_playAudio en pipeline");
    }

    log("SYS: CHAT...");
    const reply = await window.VX_chatReply(text, { mode });
    log("BOT: " + reply);

    await setState("speaking");
    log("SYS: TTS...");
    const buf = await window.VX_ttsAudio(reply);
    log("SYS: TTS bytes=" + (buf?.byteLength || 0));
    await window.VX_playAudio(buf);

    await setState("idle");
    log("SYS: Turn end ✅");
  }

  // Unlock audio (autoplay policy)
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

  window.VX_callStart = async function(opts = {}){
    const mode = opts.mode || "coach";

    if (S.running) {
      log("SYS: ya estaba corriendo.");
      return { ok:true };
    }

    S.stopRequested = false;
    S.running = true;

    log("SYS: VX_callStart(default mic) ✅");
    // NO ponemos setState aquí porque oneTurn lo maneja

    (async () => {
      while (!S.stopRequested){
        try{
          await oneTurn(mode);
        }catch(e){
          // 🔥 clave: NO matamos loop, solo registramos y seguimos
          log("SYS: ERROR turno => " + (e?.name ? `${e.name}: ` : "") + (e?.message || e));

          // Limpieza fuerte para reintentar limpio
          await hardStopAll();
          await setState("idle");

          // Espera breve y sigue
          await sleep(600);
        }

        // descanso micro
        await sleep(CFG.betweenTurnsMs);
      }

      await hardStopAll();
      S.running = false;
      await setState("idle");
      log("SYS: Loop voz detenido.");
    })();

    return { ok:true };
  };

  window.VX_callStop = async function(){
    log("SYS: VX_callStop");
    S.stopRequested = true;
    await hardStopAll();
    S.running = false;
    await setState("idle");
    return { ok:true };
  };

  window.VX_micTest3s = async function(){
    log("SYS: MicTest 3s...");
    await setState("listening");

    const stream = await getDefaultMic();
    startVAD(stream);

    const mr = makeRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.start(250);

    await sleep(3000);

    const stopped = new Promise(res => { mr.onstop = () => res(true); });
    mr.stop();
    await stopped;

    await stopAudioGraph();
    try { stream.getTracks().forEach(t => t.stop()); } catch {}

    const mimeType = mr.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    log("SYS: MicTest blob size=" + blob.size + " type=" + blob.type);

    if (!blob || blob.size < 2000) throw new Error("No se grabó audio (blob vacío o muy pequeño).");

    const url = URL.createObjectURL(blob);
    try{
      const a = new Audio(url);
      await a.play();
      await new Promise(res => { a.onended = res; a.onerror = res; });
    }finally{
      URL.revokeObjectURL(url);
    }

    await setState("idle");
    log("SYS: MicTest reproducido ✅");
    return { ok:true, size: blob.size, type: blob.type };
  };

  // Para compat con UI vieja (aunque ya no se usa)
  window.VX_refreshMics = async () => ({ ok:true, mics:[] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js cargado ✅ (default mic + VAD + loop) ");
})();

