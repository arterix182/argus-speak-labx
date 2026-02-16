/* voiceRecorder.js
   ✅ Default mic del dispositivo (sin selector)
   ✅ VAD: auto-stop por silencio (~0.7s)
   ✅ Loop: escucha → procesa → habla → repite
   ✅ Medidor nivel real: VX_onLevel(0..1)
   ✅ Mic Test 3s: VX_micTest3s()

   Requiere que voicePipeline.js exponga:
     - VX_sttTranscribe(blob, {mimeType})  [si no existe, se usa fallback /api/stt]
     - VX_chatReply(text, {mode})
     - VX_ttsAudio(text)
     - VX_playAudio(arrayBuffer)
*/

(() => {
  "use strict";

  const CFG = {
    silenceMs: 700,
    minVoiceMs: 200,
    recorderTimeslice: 250,
    vadThreshold: 0.015,   // RMS aproximado (ajustable)
    vadHangMs: 120,        // tolerancia microcortes
  };

  const S = {
    running: false,
    stopRequested: false,

    stream: null,
    mr: null,
    chunks: [],

    // VAD/Meter
    ac: null,
    analyser: null,
    srcNode: null,
    raf: 0,
    lastVoiceAt: 0,
    voiceStartedAt: 0,
    inVoice: false,
    lastAboveAt: 0,

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

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

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
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder no soportado.");
    const mr = new MediaRecorder(stream, pickMime());
    S.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) S.chunks.push(e.data);
    };
    mr.onerror = (e) => log("SYS: MediaRecorder ERROR: " + (e?.error?.message || e?.message || e));

    return mr;
  }

  function blobFromChunks(mimeType){
    if (!S.chunks.length) return null;
    return new Blob(S.chunks, { type: mimeType || S.mr?.mimeType || "audio/webm" });
  }

  async function stopStream(){
    if (S.stream){
      try { S.stream.getTracks().forEach(t => t.stop()); } catch {}
    }
    S.stream = null;
  }

  async function stopAudioGraph(){
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    pushLevel(0);

    try { S.srcNode?.disconnect(); } catch {}
    S.srcNode = null;

    try { S.analyser?.disconnect(); } catch {}
    S.analyser = null;

    if (S.ac){
      try { await S.ac.close(); } catch {}
    }
    S.ac = null;
  }

  async function hardStopAll(){
    try{
      if (S.mr && S.mr.state !== "inactive") S.mr.stop();
    }catch{}
    S.mr = null;
    S.chunks = [];

    await stopAudioGraph();
    await stopStream();

    S.inVoice = false;
    S.lastVoiceAt = 0;
    S.voiceStartedAt = 0;
    S.lastAboveAt = 0;
  }

  async function getDefaultMic(){
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia() no disponible.");

    // ✅ default mic con “helpers”
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    const tr = stream.getAudioTracks()[0];
    if (!tr) throw new Error("No se obtuvo audio track.");
    tr.enabled = true;

    return stream;
  }

  function startVAD(stream){
    // WebAudio VAD + meter
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log("SYS: AudioContext no disponible. (sin VAD/meter)"); return; }

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
        const rms = Math.sqrt(sum / data.length); // 0..~1
        const level = Math.min(1, rms * 2.5);
        pushLevel(level);

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
          // Hang tolerance
          if (S.inVoice && (now - S.lastAboveAt) > CFG.vadHangMs){
            S.inVoice = false;
          }
        }
      }catch{}
      S.raf = requestAnimationFrame(tick);
    };

    S.raf = requestAnimationFrame(tick);
    log("SYS: VAD + Meter iniciado ✅");
  }

  async function recordUntilSilence(){
    // Espera a que haya voz real (minVoiceMs) y luego corta por silencioMs
    const start = performance.now();

    // 1) Esperar que empiece la voz (o timeout 10s)
    while (!S.stopRequested){
      const now = performance.now();
      if (S.voiceStartedAt && (now - S.voiceStartedAt) >= CFG.minVoiceMs) break;
      if (now - start > 10000) { log("SYS: no se detectó voz (timeout)."); break; }
      await sleep(50);
    }

    // 2) Esperar silencio
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

    try{
      if (mr.state !== "inactive") mr.stop();
      await stopped;
    }catch{}

    const blob = blobFromChunks(mimeType);
    S.mr = null;

    return { blob, mimeType };
  }

  async function stt(blob, mimeType){
    // Prefer pipeline method if exists
    if (typeof window.VX_sttTranscribe === "function"){
      return await window.VX_sttTranscribe(blob, { mimeType });
    }

    // Fallback endpoint /api/stt
    const fd = new FormData();
    fd.append("audio", blob, "audio.webm");
    fd.append("mimeType", mimeType || "");

    const r = await fetch("/api/stt", { method:"POST", body: fd, cache:"no-store" });
    if (!r.ok) throw new Error("STT HTTP " + r.status);
    const j = await r.json();
    return j.text || "";
  }

  async function oneTurn(mode){
    // stream + VAD + recorder
    S.stream = await getDefaultMic();
    startVAD(S.stream);

    S.mr = makeRecorder(S.stream);
    S.mr.start(CFG.recorderTimeslice);
    log("SYS: Grabación iniciada ✅");

    await setState("listening");
    await recordUntilSilence();

    const { blob, mimeType } = await stopRecorderAndGetBlob();
    await stopAudioGraph();
    await stopStream();

    if (S.stopRequested){
      log("SYS: stop solicitado, cancelando turno.");
      return;
    }

    if (!blob || blob.size < 1500){
      log("SYS: Audio vacío / muy pequeño. (silencio)");
      return;
    }

    await setState("thinking");
    log("SYS: STT...");
    const text = (await stt(blob, mimeType)).trim();
    log("YOU: " + (text || "(silencio)"));

    if (!text){
      await setState("idle");
      return;
    }

    await setState("thinking");
    log("SYS: CHAT...");
    const reply = await window.VX_chatReply(text, { mode });
    log("BOT: " + reply);

    await setState("speaking");
    log("SYS: TTS...");
    const audioBuf = await window.VX_ttsAudio(reply);
    await window.VX_playAudio(audioBuf);

    await setState("idle");
  }

  // Audio unlock
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

  // Public API
  window.VX_callStart = async function(opts = {}){
    const mode = opts.mode || "coach";

    if (typeof window.VX_chatReply !== "function" ||
        typeof window.VX_ttsAudio !== "function" ||
        typeof window.VX_playAudio !== "function") {
      throw new Error("voicePipeline.js no expuso VX_chatReply / VX_ttsAudio / VX_playAudio");
    }

    if (S.running) return { ok:true };

    S.stopRequested = false;
    S.running = true;

    log("SYS: VX_callStart (default mic) ✅");
    await setState("listening");

    (async () => {
      while (!S.stopRequested){
        try{
          await oneTurn(mode);
          // descanso micro para no saturar
          await sleep(120);
        }catch(e){
          log("SYS: ERROR turno voz: " + (e?.name ? `${e.name}: ` : "") + (e?.message || e));
          await hardStopAll();
          await setState("idle");
          // si falla, no te quedes en loop infinito
          break;
        }
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

  // Mic Test 3s: graba y reproduce (sin pipeline)
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
    if (!blob || blob.size < 2000) throw new Error("No se grabó audio (blob vacío o muy pequeño).");

    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();

    await setState("idle");
    log("SYS: MicTest reproducido ✅ size=" + blob.size);
    return { ok:true, size: blob.size, type: blob.type };
  };

  // Ya no usamos selección
  window.VX_refreshMics = async () => ({ ok:true, mics:[] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js cargado ✅ (default mic, VAD, loop, test)");
})();


