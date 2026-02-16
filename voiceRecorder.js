/* voiceRecorder.js (PRO)
   Requiere: voicePipeline.js cargado antes.
   Exporta:
   - VX_setMic(deviceId)
   - VX_startCall() / VX_stopCall()
*/

(function () {
  // ---------- Config ----------
  const SILENCE_STOP_MS = 700;     // ~0.7s
  const START_THRESHOLD = 0.018;   // sube/baja según mic
  const SILENCE_THRESHOLD = 0.010; // sube/baja según ruido
  const CALIBRATE_MS = 450;

  // ---------- UI hooks (opcional) ----------
  // Si tienes barra de nivel, pon en tu HTML: <progress id="vxLevel" max="1" value="0"></progress>
  const levelEl = document.getElementById("vxLevel");

  function setAvatar(state) {
    try { if (typeof window.VX_setAvatarState === "function") window.VX_setAvatarState(state); }
    catch (_) {}
  }

  function log(msg) {
    // Si ya tienes addLog() global, úsalo
    if (typeof window.addLog === "function") window.addLog(msg);
    else console.log(msg);
  }

  // ---------- State ----------
  let callActive = false;
  let selectedMicId = "";
  let stream = null;

  // Recorder
  let mediaRecorder = null;
  let chunks = [];

  // Audio analysis (silence auto-stop)
  let audioCtx = null;
  let analyser = null;
  let srcNode = null;
  let data = null;

  // Timers
  let rmsInterval = null;
  let silenceTimer = null;

  // Turn lock (evita doble turno encima)
  let busy = false;

  // ---------- Mic selection ----------
  function VX_setMic(deviceId) {
    selectedMicId = deviceId || "";
    localStorage.setItem("VX_MIC", selectedMicId);
    log("SYS: Mic set.");
  }
  window.VX_setMic = VX_setMic;

  // ---------- AudioContext ensure ----------
  async function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (_) {}
    }
  }

  function cleanupAnalyser() {
    if (rmsInterval) { clearInterval(rmsInterval); rmsInterval = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    try { if (srcNode) srcNode.disconnect(); } catch (_) {}
    try { if (analyser) analyser.disconnect(); } catch (_) {}
    srcNode = null;
    analyser = null;
    data = null;
  }

  function stopStreamTracks() {
    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch (_) {}
    stream = null;
  }

  // ---------- RMS calc ----------
  function computeRms() {
    if (!analyser || !data) return 0;
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return Math.sqrt(sum / data.length);
  }

  // ---------- Start recording ----------
  async function startRecording() {
    if (busy) return;
    busy = true;

    try {
      await ensureAudioCtx();

      // Stream
      const constraints = {
        audio: selectedMicId
          ? { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Recorder
      chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      // Analyser
      cleanupAnalyser();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      data = new Float32Array(analyser.fftSize);

      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser);

      // Calibración rápida (para que no se quede “escuchando” eternamente)
      setAvatar("listening");
      log("SYS: Escuchando... (auto-stop por silencio)");

      let baseNoise = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < CALIBRATE_MS) {
        baseNoise = Math.max(baseNoise, computeRms());
        await new Promise(r => setTimeout(r, 30));
      }

      // Ajuste dinámico suave
      const startTh = Math.max(START_THRESHOLD, baseNoise * 2.2);
      const silenceTh = Math.max(SILENCE_THRESHOLD, baseNoise * 1.6);

      log(`SYS: Calibrado. ruido=${baseNoise.toFixed(3)} start=${startTh.toFixed(3)} silence=${silenceTh.toFixed(3)}`);

      // Start
      mediaRecorder.start(250);

      // Monitor RMS + auto stop
      let hasSpoken = false;

      rmsInterval = setInterval(() => {
        const rms = computeRms();

        // barra nivel (0..1)
        if (levelEl) {
          const v = Math.min(1, Math.max(0, rms * 8)); // escala visual
          levelEl.value = v;
        }

        if (!hasSpoken) {
          if (rms > startTh) {
            hasSpoken = true;
            // Cancelar cualquier “silenceTimer” previo
            if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
          }
          return;
        }

        // Ya habló: si baja de threshold, inicia conteo para auto-stop
        if (rms < silenceTh) {
          if (!silenceTimer) {
            silenceTimer = setTimeout(() => {
              silenceTimer = null;
              // Stop por silencio
              stopRecordingAndRunTurn();
            }, SILENCE_STOP_MS);
          }
        } else {
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        }
      }, 60);

    } catch (e) {
      log("SYS: ERROR al iniciar mic/grabación.");
      console.error(e);
      setAvatar("idle");
      stopStreamTracks();
      cleanupAnalyser();
    } finally {
      busy = false;
    }
  }

  // ---------- Stop recording + run turn ----------
  async function stopRecordingAndRunTurn() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") return;
    if (busy) return;
    busy = true;

    try {
      cleanupAnalyser();

      await new Promise((resolve) => {
        mediaRecorder.onstop = resolve;
        try { mediaRecorder.stop(); } catch (_) { resolve(); }
      });

      // armamos blob
      const blob = new Blob(chunks, { type: "audio/webm" });
      chunks = [];

      stopStreamTracks();

      // Turn: STT -> CHAT -> TTS -> PLAY
      setAvatar("thinking");
      log("SYS: STT...");

      const userText = await window.VX_transcribeAudio(blob);
      log("YOU: " + userText);

      log("SYS: CHAT...");
      const modeEl = document.getElementById("mode");
      const mode = modeEl ? modeEl.value : "coach";
      const reply = await window.VX_chatReply(userText, mode);
      log("BOT: " + reply);

      log("SYS: TTS...");
      const audioBuf = await window.VX_ttsAudio(reply);

      // speaking handled in VX_playAudio (start/ended)
      await window.VX_playAudio(audioBuf);

      // Listo para siguiente turno
      setAvatar("idle");
      log("SYS: ✅ Turno listo. Toca para hablar otra vez.");

    } catch (e) {
      setAvatar("idle");
      log("SYS: ERROR: " + (e?.message || e));
      console.error(e);
    } finally {
      busy = false;
    }
  }

  // ---------- Call control ----------
  async function VX_startCall() {
    if (callActive) return;
    callActive = true;
    setAvatar("idle");
    log("SYS: 📞 Llamada iniciada.");
    await startRecording();
  }

  function VX_stopCall() {
    callActive = false;
    cleanupAnalyser();

    try {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    } catch (_) {}

    stopStreamTracks();
    setAvatar("idle");
    log("SYS: 📴 Llamada detenida.");
  }

  window.VX_startCall = VX_startCall;
  window.VX_stopCall = VX_stopCall;

  console.log("✅ voiceRecorder loaded", {
    startCall: typeof window.VX_startCall,
    stopCall: typeof window.VX_stopCall,
    setMic: typeof window.VX_setMic,
  });

})();









