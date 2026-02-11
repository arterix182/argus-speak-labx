// voiceRecorder.js (COMPLETO) — Tap-to-talk PRO:
// - Click 1: empieza
// - Click 2: para manual SIEMPRE
// - Auto-stop por silencio (si funciona)
// - Plan B: si NO detecta voz real en 1.5s, corta
// - Failsafe: corta a los 8s pase lo que pase

(() => {
  if (window.__VX_voiceRecorderLoaded) {
    console.warn("⚠️ VX voiceRecorder already loaded, skipping");
    return;
  }
  window.__VX_voiceRecorderLoaded = true;

  // ======= Ajustes =======
  const MIN_RECORD_MS = 900;
  const SILENCE_STOP_MS = 700;

  const CALIBRATE_MS = 500;

  const NO_SPEECH_TIMEOUT_MS = 1500; // si no detecta "voz" real, corta
  const MAX_RECORD_MS = 8000;        // jamás se queda grabando infinito

  const VU_SMOOTH = 0.18;

  // Auto-calibración relativa
  const START_MULT = 2.5;      // para declarar "speech started"
  const SILENCE_MULT = 1.25;   // para declarar "silencio" después de hablar

  // ======= Estado =======
  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;
  let isRecording = false;
  let isBusy = false;

  // WebAudio
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let streamRef = null;
  let rafId = null;

  let noiseFloor = 0.01;
  let startThreshold = 0.03;
  let silenceThreshold = 0.02;

  let speechStarted = false;
  let firstSpeechAt = null;
  let silenceSince = null;
  let vu = 0;

  function setState(s) { window.__voiceState?.(s); console.log("STATE:", s); }
  function log(who, msg) { window.__voiceLog?.(who, msg); console.log(`${who}:`, msg); }
  function setVU(v) { window.__voiceVU?.(v); }

  function cleanupMic() {
    try { if (rafId) cancelAnimationFrame(rafId); } catch {}
    rafId = null;

    try { if (sourceNode) sourceNode.disconnect(); } catch {}
    try { if (analyser) analyser.disconnect(); } catch {}
    sourceNode = null; analyser = null;

    try { if (audioCtx) audioCtx.close(); } catch {}
    audioCtx = null;

    try { if (streamRef) streamRef.getTracks().forEach(t => t.stop()); } catch {}
    streamRef = null;

    setVU(0);
    vu = 0;
  }

  function calcRMS() {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = (buf[i] - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length);
  }

  async function calibrate() {
    const t0 = Date.now();
    let samples = [];
    while (Date.now() - t0 < CALIBRATE_MS) {
      samples.push(calcRMS());
      await new Promise(r => setTimeout(r, 30));
    }
    samples.sort((a,b)=>a-b);
    const median = samples[Math.floor(samples.length*0.5)] || 0.01;

    noiseFloor = Math.max(0.006, Math.min(0.07, median));
    startThreshold = Math.min(0.20, noiseFloor * START_MULT);
    silenceThreshold = Math.min(0.15, noiseFloor * SILENCE_MULT);

    log("SYS", `Calibrado. ruido=${noiseFloor.toFixed(3)} start=${startThreshold.toFixed(3)} silence=${silenceThreshold.toFixed(3)}`);
  }

  function tick() {
    const rms = calcRMS();
    const now = Date.now();
    const recordedMs = now - startedAt;

    vu = vu + (rms - vu) * VU_SMOOTH;
    setVU(Math.min(1, Math.max(0, vu * 4)));

    // Failsafe total
    if (recordedMs >= MAX_RECORD_MS) {
      VX_stopRec().catch(console.warn);
      return;
    }

    // Detecta speech started
    if (!speechStarted && rms >= startThreshold) {
      speechStarted = true;
      firstSpeechAt = now;
      silenceSince = null;
    }

    // Plan B: si no detecta speech en X ms, corta (evita grabación eterna en ruido)
    if (!speechStarted && recordedMs >= NO_SPEECH_TIMEOUT_MS) {
      VX_stopRec().catch(console.warn);
      return;
    }

    // Auto-stop por silencio solo si ya detectó speech
    if (speechStarted) {
      if (rms < silenceThreshold) {
        if (silenceSince == null) silenceSince = now;
        const silentMs = now - silenceSince;

        if (recordedMs >= MIN_RECORD_MS && silentMs >= SILENCE_STOP_MS) {
          VX_stopRec().catch(console.warn);
          return;
        }
      } else {
        silenceSince = null;
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  async function VX_startRec() {
    if (isRecording) return;

    chunks = [];
    startedAt = Date.now();
    speechStarted = false;
    firstSpeechAt = null;
    silenceSince = null;

    streamRef = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    mediaRecorder = new MediaRecorder(streamRef, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(streamRef);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    sourceNode.connect(analyser);

    mediaRecorder.start();
    isRecording = true;

    setState("listening");
    log("SYS", "Escuchando... (auto + manual stop)");
    await calibrate();
    tick();
  }

  function VX_stopRec() {
    return new Promise((resolve, reject) => {
      if (!mediaRecorder || !isRecording) return reject(new Error("Not recording"));

      mediaRecorder.onstop = () => {
        isRecording = false;
        const blob = new Blob(chunks, { type: "audio/webm" });
        cleanupMic();
        resolve(blob);
      };

      try { mediaRecorder.stop(); }
      catch (e) { isRecording = false; cleanupMic(); reject(e); }
    });
  }

  async function VX_runVoiceTurn(blob) {
    if (isBusy) {
      log("SYS", "Estoy procesando el turno anterior. Un segundo.");
      return;
    }
    isBusy = true;

    try {
      setState("thinking");

      const ms = Date.now() - startedAt;
      if (ms < MIN_RECORD_MS) {
        setState("idle");
        log("SYS", "Muy corto. Intenta hablar 1–2 segundos.");
        return;
      }

      log("SYS", "STT...");
      const text = await window.VX_transcribeAudio(blob);

      if (!text) {
        setState("idle");
        log("SYS", "No se detectó voz. (O el ruido ganó). Intenta más cerca del mic.");
        return;
      }

      log("YOU", text);

      log("SYS", "CHAT...");
      const reply = await window.VX_chatReply(text);
      log("BOT", reply);

      log("SYS", "TTS...");
      try {
        setState("speaking");
        const buf = await window.VX_ttsAudio(reply);
        await window.VX_playAudio(buf);
      } catch (ttsErr) {
        console.warn("TTS error (ignored):", ttsErr);
        log("SYS", "TTS no disponible (ok).");
      }

      setState("idle");
    } catch (e) {
      console.error("❌ Voice turn failed:", e);
      setState("error");
      alert("Falló voz/IA: " + (e?.message || e));
    } finally {
      isBusy = false;
    }
  }

  // Toggle: click = start; click otra vez = stop manual SIEMPRE
  async function VX_toggleTalk() {
    if (isRecording) {
      try {
        const blob = await VX_stopRec();
        await VX_runVoiceTurn(blob);
      } catch (e) { console.warn(e); }
      return;
    }

    try {
      await VX_startRec();
    } catch (e) {
      console.error("Mic start error:", e);
      setState("error");
      alert("No pude acceder al micrófono. Revisa permisos del navegador.");
    }
  }

  window.VX_toggleTalk = VX_toggleTalk;
  window.VX_isRecording = () => isRecording;

  console.log("✅ voiceRecorder loaded (VX) — PRO toggle + no-speech timeout + max");
})();




