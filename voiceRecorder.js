// voiceRecorder.js — grabación + VU meter + auto-stop por silencio
// Compatible con:
// - window.VX_transcribeAudio(blob)
// - window.VX_chatReply(text)
// - window.VX_ttsAudio(text) (opcional)
// - window.VX_playAudio(buf) (opcional)
// UI hooks esperados:
// - window.__voiceState("idle|listening|thinking|speaking|error")
// - window.__voiceLog("SYS|YOU|BOT", "msg")
// - window.__voiceVU(0..1)

(() => {
  let isRecording = false;

  let mediaRecorder = null;
  let chunks = [];
  let stream = null;

  let audioCtx = null;
  let analyser = null;
  let srcNode = null;
  let rafId = null;

  // VAD / Auto-stop
  let calibrated = false;
  let noiseFloor = 0.01;     // RMS base
  let startThresh = 0.02;    // RMS para considerar “habla”
  let silenceThresh = 0.015; // RMS para silencio
  let heardSpeech = false;
  let silenceMs = 0;
  let lastTs = 0;

  const LOG = (who, msg) => window.__voiceLog?.(who, msg);
  const STATE = (s) => window.__voiceState?.(s);
  const VU = (v) => window.__voiceVU?.(v);

  function stopTracks() {
    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch {}
    stream = null;
  }

  async function ensureAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new AudioCtx();
    // IMPORTANTE: si está suspendido, no analiza nada.
    if (audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch {}
    }
  }

  function computeRms(timeDomain) {
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const x = (timeDomain[i] - 128) / 128; // -1..1
      sum += x * x;
    }
    return Math.sqrt(sum / timeDomain.length); // 0..1
  }

  async function calibrateNoise(ms = 700) {
    // mide ruido ambiente para ajustar thresholds
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    let acc = 0, n = 0;

    while (performance.now() - t0 < ms) {
      analyser.getByteTimeDomainData(buf);
      const rms = computeRms(buf);
      acc += rms;
      n++;
      await new Promise(r => setTimeout(r, 30));
    }

    noiseFloor = n ? acc / n : 0.01;
    // thresholds “inteligentes”
    startThresh = Math.max(0.02, noiseFloor * 2.2);
    silenceThresh = Math.max(0.012, noiseFloor * 1.35);

    calibrated = true;
    LOG("SYS", `Calibrado. ruido=${noiseFloor.toFixed(3)} start=${startThresh.toFixed(3)} silence=${silenceThresh.toFixed(3)}`);
  }

  function startVuAndVadLoop() {
    const buf = new Uint8Array(analyser.fftSize);

    heardSpeech = false;
    silenceMs = 0;
    lastTs = performance.now();

    const loop = () => {
      rafId = requestAnimationFrame(loop);

      analyser.getByteTimeDomainData(buf);
      const rms = computeRms(buf);

      // VU meter: amplifica un poco para que sea “visible”
      const vu = Math.min(1, rms * 6.0);
      VU(vu);

      const now = performance.now();
      const dt = now - lastTs;
      lastTs = now;

      // VAD: detecta si ya habló (pasa startThresh)
      if (!heardSpeech && rms > startThresh) heardSpeech = true;

      // Auto-stop cuando ya habló y luego hay silencio sostenido
      if (heardSpeech) {
        if (rms < silenceThresh) silenceMs += dt;
        else silenceMs = 0;

        // ~0.7s de silencio → stop
        if (silenceMs >= 700) {
          // evita doble-stop
          if (isRecording) {
            LOG("SYS", "Silencio detectado. Deteniendo…");
            stopRecording(true);
          }
        }
      }
    };

    loop();
  }

  async function startRecording() {
    if (isRecording) return;

    // 1) Permisos del mic
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("No pude acceder al micrófono. Revisa permisos del navegador/Windows.");
      return;
    }

    // 2) Analyser + VU
    await ensureAudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    try {
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser);
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("Falló el analizador de audio. (MediaStreamSource).");
      stopTracks();
      return;
    }

    // 3) Calibración rápida (solo si no se ha hecho)
    if (!calibrated) {
      LOG("SYS", "Calibrando ruido… (0.7s)");
      await calibrateNoise(700);
    }

    // 4) MediaRecorder (con fallback de mime)
    chunks = [];
    let options = {};
    const m1 = "audio/webm;codecs=opus";
    const m2 = "audio/webm";
    const m3 = "audio/mp4"; // some browsers
    if (MediaRecorder.isTypeSupported?.(m1)) options.mimeType = m1;
    else if (MediaRecorder.isTypeSupported?.(m2)) options.mimeType = m2;
    else if (MediaRecorder.isTypeSupported?.(m3)) options.mimeType = m3;

    try {
      mediaRecorder = new MediaRecorder(stream, options);
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("Tu navegador no soporta MediaRecorder para audio.");
      stopTracks();
      return;
    }

    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    mediaRecorder.onerror = (ev) => {
      console.error("MediaRecorder error:", ev);
      STATE("error");
      alert("Error de grabación. Reintenta.");
      stopRecording(true);
    };

    mediaRecorder.onstop = async () => {
      // armado del blob
      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });

      // Limpia recursos
      try { if (rafId) cancelAnimationFrame(rafId); } catch {}
      rafId = null;

      try { srcNode?.disconnect(); } catch {}
      srcNode = null;
      analyser = null;

      stopTracks();

      // Si se detuvo sin grabar nada
      if (!blob || blob.size < 1200) {
        LOG("SYS", "Habla al menos 1 segundo. Intenta de nuevo.");
        STATE("idle");
        return;
      }

      // Pipeline
      try {
        STATE("thinking");
        LOG("SYS", "STT…");

        if (typeof window.VX_transcribeAudio !== "function") {
          throw new Error("VX_transcribeAudio no está definido (STT).");
        }
        const text = await window.VX_transcribeAudio(blob);
        const clean = (text || "").trim();

        LOG("YOU", clean || "(vacío)");

        if (!clean) {
          LOG("SYS", "No detecté voz clara. Acércate al mic y habla 2–3s.");
          STATE("idle");
          return;
        }

        LOG("SYS", "CHAT…");
        if (typeof window.VX_chatReply !== "function") {
          throw new Error("VX_chatReply no está definido (CHAT).");
        }
        const reply = await window.VX_chatReply(clean);
        LOG("BOT", reply || "(sin respuesta)");

        // TTS
        if (window.VX_ttsAudio && window.VX_playAudio && reply) {
          LOG("SYS", "TTS…");
          STATE("speaking");
          const buf = await window.VX_ttsAudio(reply);
          await window.VX_playAudio(buf);
        }

        STATE("idle");
      } catch (e) {
        console.error(e);
        STATE("error");
        alert("Falló voz/IA: " + (e?.message || e));
        // vuelve a idle para reintentar
        STATE("idle");
      }
    };

    // 5) Arranca
    isRecording = true;
    STATE("listening");
    LOG("SYS", "Escuchando… (auto-stop por silencio)");
    startVuAndVadLoop();

    try {
      mediaRecorder.start(250); // timeslice para que no se muera en algunos navegadores
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("No pude iniciar la grabación.");
      isRecording = false;
      stopTracks();
    }
  }

  function stopRecording(fromAutoStop = false) {
    if (!isRecording) return;

    isRecording = false;
    // no cambies a thinking aquí; se cambia al procesar en onstop
    try { if (rafId) cancelAnimationFrame(rafId); } catch {}
    rafId = null;
    VU(0);

    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch (e) {
      console.error(e);
      // cleanup duro
      stopTracks();
      STATE("idle");
    }
  }

  // Toggle público (lo usa el botón del index)
  window.VX_toggleTalk = async () => {
    // Asegura gesto del usuario para AudioContext
    if (!isRecording) await startRecording();
    else stopRecording(false);
  };

  console.log("✅ voiceRecorder loaded (VU + VAD + pipeline)");
})();





