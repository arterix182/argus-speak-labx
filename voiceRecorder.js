// voiceRecorder.js (COMPLETO) — Tap-to-Talk + Auto-stop por silencio (VAD-lite)
// Requiere: window.VX_transcribeAudio, window.VX_chatReply, window.VX_ttsAudio, window.VX_playAudio

(() => {
  if (window.__VX_voiceRecorderLoaded) {
    console.warn("⚠️ VX voiceRecorder already loaded, skipping");
    return;
  }
  window.__VX_voiceRecorderLoaded = true;

  // ======= Ajustes finos (chido vs sensible) =======
  const MIN_RECORD_MS = 900;           // mínimo para evitar clips ridículos
  const SILENCE_STOP_MS = 700;         // silencio continuo para auto-stop
  const START_SPEECH_THRESHOLD = 0.03; // RMS para considerar "ya habló"
  const SILENCE_THRESHOLD = 0.018;     // RMS debajo de esto = silencio
  const VU_SMOOTH = 0.15;              // suavizado del medidor

  // ======= Estado =======
  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;
  let isRecording = false;
  let isBusy = false; // evita doble turno simultáneo

  // WebAudio para VAD
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let streamRef = null;
  let rafId = null;

  let speechStarted = false;
  let silenceSince = null;
  let vu = 0;

  function setState(s) {
    window.__voiceState?.(s);
    console.log("STATE:", s);
  }

  function log(who, msg) {
    window.__voiceLog?.(who, msg);
    console.log(`${who}:`, msg);
  }

  function setVU(v) {
    // v 0..1
    window.__voiceVU?.(v);
  }

  function cleanupMic() {
    try {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    } catch {}

    try { if (sourceNode) sourceNode.disconnect(); } catch {}
    try { if (analyser) analyser.disconnect(); } catch {}

    sourceNode = null;
    analyser = null;

    try { if (audioCtx) audioCtx.close(); } catch {}
    audioCtx = null;

    try {
      if (streamRef) {
        streamRef.getTracks().forEach(t => t.stop());
      }
    } catch {}
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
      const x = (buf[i] - 128) / 128; // -1..1
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length); // 0..~1
  }

  function tickVAD() {
    const rms = calcRMS();

    // VU meter suavizado
    vu = vu + (rms - vu) * VU_SMOOTH;
    setVU(Math.min(1, Math.max(0, vu * 4))); // *4 para hacerlo visible

    // Detecta inicio de habla
    if (!speechStarted && rms >= START_SPEECH_THRESHOLD) {
      speechStarted = true;
      silenceSince = null;
    }

    // Auto-stop por silencio una vez que ya habló
    if (speechStarted) {
      if (rms < SILENCE_THRESHOLD) {
        if (silenceSince == null) silenceSince = Date.now();
        const silentMs = Date.now() - silenceSince;
        const recordedMs = Date.now() - startedAt;
        if (recordedMs >= MIN_RECORD_MS && silentMs >= SILENCE_STOP_MS) {
          // stop automático
          VX_stopRec().catch(console.warn);
          return; // no seguir tick
        }
      } else {
        silenceSince = null;
      }
    }

    rafId = requestAnimationFrame(tickVAD);
  }

  async function VX_startRec() {
    if (isRecording) return;

    chunks = [];
    startedAt = Date.now();
    speechStarted = false;
    silenceSince = null;

    // Permisos mic (debe ser por gesto del usuario)
    streamRef = await navigator.mediaDevices.getUserMedia({ audio: true });

    // MediaRecorder
    mediaRecorder = new MediaRecorder(streamRef, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    // WebAudio analyser para VAD
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(streamRef);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    sourceNode.connect(analyser);

    mediaRecorder.start();
    isRecording = true;

    setState("listening");
    log("SYS", "Escuchando... (se detiene solo con silencio)");
    tickVAD();
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

      try {
        mediaRecorder.stop();
      } catch (e) {
        isRecording = false;
        cleanupMic();
        reject(e);
      }
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
        log("SYS", "Habla al menos 1 segundo. Intenta de nuevo.");
        return;
      }

      log("SYS", "STT...");
      const text = await window.VX_transcribeAudio(blob);

      if (!text) {
        setState("idle");
        log("SYS", "No se detectó voz. Habla más fuerte o acércate al mic.");
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
        // Si TTS falla, NO tiramos el flujo: seguimos con texto
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

  // Toggle: si está grabando -> stop y procesa; si no -> empieza
  async function VX_toggleTalk() {
    if (isRecording) {
      try {
        const blob = await VX_stopRec();
        await VX_runVoiceTurn(blob);
      } catch (e) {
        console.warn(e);
      }
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

  // Exports
  window.VX_toggleTalk = VX_toggleTalk;
  window.VX_isRecording = () => isRecording;

  // (Opcional) compat: si algún HTML viejo llama estas:
  window.VX_startRec = VX_startRec;
  window.VX_runVoiceTurn = async () => {
    // si alguien llama "run" sin parar, paramos y procesamos
    if (isRecording) {
      const blob = await VX_stopRec();
      await VX_runVoiceTurn(blob);
    }
  };

  console.log("✅ voiceRecorder loaded (VX) — Tap-to-Talk + VAD-lite");
})();




