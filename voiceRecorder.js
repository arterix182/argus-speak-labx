(() => {
  "use strict";

  const CFG = {
    silenceMs: 900,          // más tolerante
    maxRecordMs: 6500,       // límite duro: si VAD falla, grabamos 6.5s y mandamos
    recorderTimeslice: 250,
    vadThreshold: 0.008,     // 🔥 bajamos umbral (antes 0.015)
    vadHangMs: 180,
    betweenTurnsMs: 220
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

    lastAboveAt: 0,
    lastVoiceAt: 0,
    lastRms: 0
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function log(msg){
    console.log("[VX]", msg);
    if (typeof window.VX_onLog === "function") { try { window.VX_onLog(msg); } catch {} }
  }
  async function setState(st){
    if (typeof window.VX_onState === "function") { try { await window.VX_onState(st); } catch {} }
  }
  function level(p){
    if (typeof window.VX_onLevel === "function") { try { window.VX_onLevel(p); } catch {} }
  }

  function pickMime(){
    const list = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"];
    for (const m of list) if (window.MediaRecorder?.isTypeSupported?.(m)) return { mimeType: m };
    return {};
  }

  async function getDefaultMic(){
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    const tr = stream.getAudioTracks?.()[0];
    if (!tr) throw new Error("No audio track");
    tr.enabled = true;
    return stream;
  }

  function makeRecorder(stream){
    const mr = new MediaRecorder(stream, pickMime());
    S.chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) S.chunks.push(e.data); };
    mr.onerror = (e) => log("MediaRecorder ERROR: " + (e?.error?.message || e?.message || e));
    return mr;
  }

  function blobFromChunks(mimeType){
    if (!S.chunks.length) return null;
    return new Blob(S.chunks, { type: mimeType || S.mr?.mimeType || "audio/webm" });
  }

  async function stopStream(){
    if (S.stream) { try { S.stream.getTracks().forEach(t => t.stop()); } catch {} }
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
    if (S.ac) { try { await S.ac.close(); } catch {} }
    S.ac = null;

    S.lastAboveAt = 0;
    S.lastVoiceAt = 0;
    S.lastRms = 0;
  }

  async function hardStopAll(){
    try { if (S.mr && S.mr.state !== "inactive") S.mr.stop(); } catch {}
    S.mr = null;
    S.chunks = [];
    await stopAudioGraph();
    await stopStream();
  }

  function startMeterAndVAD(stream){
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    S.ac = new AC();
    S.analyser = S.ac.createAnalyser();
    S.analyser.fftSize = 1024;

    S.srcNode = S.ac.createMediaStreamSource(stream);
    S.srcNode.connect(S.analyser);

    const data = new Uint8Array(S.analyser.frequencyBinCount);

    const tick = () => {
      try{
        S.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i=0;i<data.length;i++){
          const v = (data[i] - 128) / 128;
          sum += v*v;
        }
        const rms = Math.sqrt(sum / data.length);
        S.lastRms = rms;

        level(Math.min(1, rms * 3));

        const now = performance.now();
        const above = rms >= CFG.vadThreshold;
        if (above){
          S.lastAboveAt = now;
          S.lastVoiceAt = now;
        }
      }catch{}
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
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
    if (typeof window.VX_sttTranscribe === "function") {
      return await window.VX_sttTranscribe(blob, { mimeType });
    }
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("mimeType", mimeType || blob.type || "audio/webm");
    const r = await fetch("/api/stt", { method:"POST", body: fd, cache:"no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ("STT HTTP " + r.status));
    return (j.text || "").trim();
  }

  async function recordSegment(){
    const start = performance.now();
    const hardStopAt = start + CFG.maxRecordMs;

    // esperamos “silencio” solo si alguna vez detectamos nivel > threshold.
    // Si nunca detecta (VAD roto), se corta por maxRecordMs igual.
    while (!S.stopRequested) {
      const now = performance.now();

      if (now >= hardStopAt) {
        log("SYS: maxRecordMs alcanzado (VAD no confiable).");
        break;
      }

      // Si hubo voz y luego silencio prolongado
      if (S.lastVoiceAt && (now - S.lastVoiceAt) >= CFG.silenceMs) {
        log("SYS: silencio detectado, cortando.");
        break;
      }

      await sleep(60);
    }
  }

  async function oneTurn(mode){
    await setState("listening");
    log("SYS: Turn start (listening). threshold=" + CFG.vadThreshold);

    S.stream = await getDefaultMic();
    startMeterAndVAD(S.stream);

    S.mr = makeRecorder(S.stream);
    S.mr.start(CFG.recorderTimeslice);
    log("SYS: Grabación iniciada ✅ mime=" + (S.mr.mimeType || "unknown"));

    await recordSegment();

    const { blob, mimeType } = await stopRecorderAndGetBlob();
    await stopAudioGraph();
    await stopStream();

    if (S.stopRequested) return;

    if (!blob) {
      log("SYS: blob null (sin chunks). rmsLast=" + S.lastRms);
      await setState("idle");
      return;
    }

    log("SYS: blob size=" + blob.size + " type=" + blob.type + " rmsLast=" + S.lastRms);

    if (blob.size < 1800) {
      log("SYS: audio muy pequeño, ignorando.");
      await setState("idle");
      return;
    }

    await setState("thinking");
    log("SYS: STT...");

    const text = (await stt(blob, mimeType)).trim();
    log("YOU: " + (text || "(vacío)"));
    if (!text) { await setState("idle"); return; }

    log("SYS: CHAT...");
    const reply = await window.VX_chatReply(text, { mode });
    log("BOT: " + reply);

    await setState("speaking");
    log("SYS: TTS...");
    const buf = await window.VX_ttsAudio(reply);
    await window.VX_playAudio(buf);

    await setState("idle");
    log("SYS: Turn end ✅");
  }

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

    if (typeof window.VX_chatReply !== "function" ||
        typeof window.VX_ttsAudio !== "function" ||
        typeof window.VX_playAudio !== "function") {
      throw new Error("Pipeline incompleto (faltan VX_chatReply/VX_ttsAudio/VX_playAudio)");
    }

    if (S.running) return { ok:true };

    S.stopRequested = false;
    S.running = true;
    log("SYS: VX_callStart(default mic) ✅");

    (async () => {
      while (!S.stopRequested){
        try{
          await oneTurn(mode);
        }catch(e){
          log("SYS: ERROR turno => " + (e?.name ? `${e.name}: ` : "") + (e?.message || e));
          await hardStopAll();
          await setState("idle");
          await sleep(600);
        }
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

  // compat (UI vieja)
  window.VX_refreshMics = async () => ({ ok:true, mics:[] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js cargado ✅ (default mic + VAD tolerante + segmento fijo)");
})();


