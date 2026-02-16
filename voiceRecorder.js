/* voiceRecorder.js
   ✅ Sin selector: SIEMPRE usa mic default del sistema
   ✅ VAD auto-stop por silencio (~0.7s)
   ✅ Loop (iniciar llamada = escuchar → STT → chat → TTS → repetir)
   ✅ Medidor: window.VX_onLevel(0..1)
   ✅ Mic Test 3s: window.VX_micTest3s()

   Requiere voicePipeline.js con:
   - VX_sttTranscribe
   - VX_chatReply
   - VX_ttsAudio
   - VX_playAudio
*/

(() => {
  "use strict";

  const CFG = {
    silenceMs: 700,
    minVoiceMs: 180,
    recorderTimeslice: 250,
    vadThreshold: 0.015, // si está muy sensible o sordo, ajustamos
    vadHangMs: 120,
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

  function log(msg) {
    console.log("[VX]", msg);
    if (typeof window.VX_onLog === "function") window.VX_onLog(msg);
  }
  async function setState(st) {
    if (typeof window.VX_onState === "function") {
      try { await window.VX_onState(st); } catch {}
    }
  }
  function pushLevel(p) {
    if (typeof window.VX_onLevel === "function") {
      try { window.VX_onLevel(p); } catch {}
    }
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function pickMime() {
    const list = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"];
    for (const m of list) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return { mimeType: m };
    }
    return {};
  }

  async function getDefaultMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia no disponible");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const tr = stream.getAudioTracks()[0];
    if (!tr) throw new Error("No se obtuvo audio track");
    tr.enabled = true;
    return stream;
  }

  function makeRecorder(stream) {
    if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder no soportado");
    const mr = new MediaRecorder(stream, pickMime());
    S.chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) S.chunks.push(e.data); };
    mr.onerror = (e) => log("SYS: MediaRecorder ERROR: " + (e?.error?.message || e?.message || e));
    return mr;
  }

  function blobFromChunks(mimeType) {
    if (!S.chunks.length) return null;
    return new Blob(S.chunks, { type: mimeType || S.mr?.mimeType || "audio/webm" });
  }

  async function stopStream() {
    if (S.stream) { try { S.stream.getTracks().forEach(t => t.stop()); } catch {} }
    S.stream = null;
  }

  async function stopAudioGraph() {
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    pushLevel(0);

    try { S.srcNode?.disconnect(); } catch {}
    S.srcNode = null;
    try { S.analyser?.disconnect(); } catch {}
    S.analyser = null;

    if (S.ac) { try { await S.ac.close(); } catch {} }
    S.ac = null;

    S.inVoice = false;
    S.voiceStartedAt = 0;
    S.lastVoiceAt = 0;
    S.lastAboveAt = 0;
  }

  async function hardStopAll() {
    try { if (S.mr && S.mr.state !== "inactive") S.mr.stop(); } catch {}
    S.mr = null;
    S.chunks = [];
    await stopAudioGraph();
    await stopStream();
  }

  function startVAD(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log("SYS: AudioContext no disponible (sin VAD/meter)"); return; }

    S.ac = new AC();
    S.analyser = S.ac.createAnalyser();
    S.analyser.fftSize = 1024;

    S.srcNode = S.ac.createMediaStreamSource(stream);
    S.srcNode.connect(S.analyser);

    const data = new Uint8Array(S.analyser.frequencyBinCount);

    const tick = () => {
      try {
        S.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = Math.min(1, rms * 2.5);
        pushLevel(level);

        const now = performance.now();
        const above = rms >= CFG.vadThreshold;

        if (above) {
          S.lastAboveAt = now;
          if (!S.inVoice) {
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
      } catch {}
      S.raf = requestAnimationFrame(tick);
    };

    S.raf = requestAnimationFrame(tick);
  }

  async function recordUntilSilence() {
    const start = performance.now();

    // 1) esperar voz real o timeout
    while (!S.stopRequested) {
      const now = performance.now();
      if (S.voiceStartedAt && (now - S.voiceStartedAt) >= CFG.minVoiceMs) break;
      if (now - start > 10000) { log("SYS: no se detectó voz (timeout)."); break; }
      await sleep(50);
    }

    // 2) esperar silencio
    while (!S.stopRequested) {
      const now = performance.now();
      const sinceVoice = S.lastVoiceAt ? (now - S.lastVoiceAt) : 999999;
      if (sinceVoice >= CFG.silenceMs) break;
      await sleep(50);
    }
  }

  async function stopRecorderAndGetBlob() {
    if (!S.mr) return { blob: null, mimeType: null };

    const mr = S.mr;
    const mimeType = mr.mimeType || "audio/webm";
    const stopped = new Promise(res => { mr.onstop = () => res(true); });

    try { if (mr.state !== "inactive") mr.stop(); } catch {}
    await stopped;

    const blob = blobFromChunks(mimeType);
    S.mr = null;
    return { blob, mimeType };
  }

  async function oneTurn(mode) {
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

    if (S.stopRequested) return;

    if (!blob || blob.size < 1500) {
      log("SYS: Audio vacío / muy pequeño (silencio).");
      await setState("idle");
      return;
    }

    await setState("thinking");
    log("SYS: STT...");
    const text = (await window.VX_sttTranscribe(blob, { mimeType })).trim();
    log("YOU: " + (text || "(silencio)"));
    if (!text) { await setState("idle"); return; }

    log("SYS: CHAT...");
    const reply = await window.VX_chatReply(text, { mode });
    log("BOT: " + reply);

    await setState("speaking");
    log("SYS: TTS...");
    const buf = await window.VX_ttsAudio(reply);
    await window.VX_playAudio(buf);

    await setState("idle");
  }

  // Unlock (autoplay policy)
  window.VX_unlockAudio = async function () {
    try {
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
    } catch {}
  };

  // Start/Stop loop
  window.VX_callStart = async function (opts = {}) {
    const mode = opts.mode || "coach";

    // Validación clara (esto te estaba tronando)
    if (typeof window.VX_chatReply !== "function" ||
        typeof window.VX_ttsAudio !== "function" ||
        typeof window.VX_playAudio !== "function" ||
        typeof window.VX_sttTranscribe !== "function") {
      throw new Error("voicePipeline.js no expuso VX_chatReply / VX_ttsAudio / VX_playAudio / VX_sttTranscribe");
    }

    if (S.running) return { ok: true };
    S.stopRequested = false;
    S.running = true;

    log("SYS: VX_callStart (default mic) ✅");

    (async () => {
      while (!S.stopRequested) {
        try {
          await oneTurn(mode);
          await sleep(120);
        } catch (e) {
          log("SYS: ERROR turno voz: " + (e?.name ? `${e.name}: ` : "") + (e?.message || e));
          await hardStopAll();
          break;
        }
      }
      await hardStopAll();
      S.running = false;
      await setState("idle");
      log("SYS: Loop voz detenido.");
    })();

    return { ok: true };
  };

  window.VX_callStop = async function () {
    S.stopRequested = true;
    await hardStopAll();
    S.running = false;
    await setState("idle");
    return { ok: true };
  };

  // Mic test 3s
  window.VX_micTest3s = async function () {
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
    try {
      const a = new Audio(url);
      await a.play();
      await new Promise(res => { a.onended = res; a.onerror = res; });
    } finally {
      URL.revokeObjectURL(url);
    }

    await setState("idle");
    log("SYS: MicTest reproducido ✅ size=" + blob.size);
    return { ok: true, size: blob.size, type: blob.type };
  };

  // 🔥 Matamos selector por completo (compat)
  window.VX_refreshMics = async () => ({ ok: true, mics: [] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js cargado ✅ (default mic + VAD + loop)");
})();


