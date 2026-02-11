// voiceRecorder.js — toggle record + VU + auto-stop silence + mic test

(() => {
  let isRecording = false;

  let mediaRecorder = null;
  let chunks = [];
  let stream = null;

  let audioCtx = null;
  let analyser = null;
  let srcNode = null;
  let rafId = null;

  // Auto-stop por silencio
  let calibrated = false;
  let noiseFloor = 0.01;
  let startThresh = 0.02;
  let silenceThresh = 0.015;
  let heardSpeech = false;
  let silenceMs = 0;
  let lastTs = 0;

  const LOG = (who, msg) => window.__voiceLog?.(who, msg);
  const STATE = (s) => window.__voiceState?.(s);
  const VU = (v) => window.__voiceVU?.(v);

  function stopTracks() {
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
  }

  async function ensureAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state !== "running") {
      try { await audioCtx.resume(); } catch {}
    }
  }

  function computeRms(timeDomain) {
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const x = (timeDomain[i] - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / timeDomain.length);
  }

  async function calibrateNoise(ms = 650) {
    const buf = new Uint8Array(analyser.fftSize);
    const t0 = performance.now();
    let acc = 0, n = 0;

    while (performance.now() - t0 < ms) {
      analyser.getByteTimeDomainData(buf);
      const rms = computeRms(buf);
      acc += rms; n++;
      await new Promise(r => setTimeout(r, 28));
    }

    noiseFloor = n ? acc / n : 0.01;
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

      // VU visible
      const vu = Math.min(1, rms * 6.0);
      VU(vu);

      const now = performance.now();
      const dt = now - lastTs;
      lastTs = now;

      if (!heardSpeech && rms > startThresh) heardSpeech = true;

      if (heardSpeech) {
        if (rms < silenceThresh) silenceMs += dt;
        else silenceMs = 0;

        if (silenceMs >= 700) {
          if (isRecording) {
            LOG("SYS", "Silencio detectado. Deteniendo…");
            stopRecording();
          }
        }
      }
    };
    loop();
  }

  async function getMicStream() {
    const micId = (window.VX_selectedMicId || "").trim();

    const baseAudio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };

    const constraints = micId
      ? { audio: { ...baseAudio, deviceId: { exact: micId } } }
      : { audio: baseAudio };

    return await navigator.mediaDevices.getUserMedia(constraints);
  }

  function logTrackInfo(s) {
    try {
      const t = s.getAudioTracks?.()[0];
      if (!t) { LOG("SYS", "No audio track."); return; }
      const st = t.getSettings?.() || {};
      LOG("SYS", `Track: enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`);
      LOG("SYS", `Settings: sampleRate=${st.sampleRate || "?"} channelCount=${st.channelCount || "?"}`);
    } catch {}
  }

  // ===== MIC TEST =====
  window.VX_runMicTest = async (ms = 2200) => {
    let s = null;
    try {
      LOG("SYS", "Mic test… habla fuerte 2s.");
      s = await getMicStream();
      logTrackInfo(s);

      await ensureAudioContext();
      const a = audioCtx.createAnalyser();
      a.fftSize = 2048;
      const src = audioCtx.createMediaStreamSource(s);
      src.connect(a);

      const buf = new Uint8Array(a.fftSize);
      const t0 = performance.now();
      let peak = 0;

      while (performance.now() - t0 < ms) {
        a.getByteTimeDomainData(buf);
        const rms = computeRms(buf);
        peak = Math.max(peak, rms);
        VU(Math.min(1, rms * 6));
        await new Promise(r => setTimeout(r, 40));
      }

      src.disconnect();
      s.getTracks().forEach(t => t.stop());
      VU(0);

      LOG("SYS", `Mic test peak RMS=${peak.toFixed(4)} (${peak > 0.01 ? "OK" : "CERO / MUDO"})`);
      if (peak <= 0.01) {
        alert("Mic test: no entra audio. Cambia mic en el selector o revisa Windows Input.");
      }
    } catch (e) {
      console.error(e);
      alert("Mic test falló: " + (e?.message || e));
      try { s?.getTracks()?.forEach(t => t.stop()); } catch {}
      VU(0);
    }
  };

  // ===== RECORD =====
  async function startRecording() {
    if (isRecording) return;

    try {
      stream = await getMicStream();
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("No pude acceder al micrófono. Revisa permisos y/o selecciona otro mic.");
      return;
    }

    logTrackInfo(stream);

    await ensureAudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    try {
      srcNode = audioCtx.createMediaStreamSource(stream);
      srcNode.connect(analyser);
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("Falló MediaStreamSource (analizador).");
      stopTracks();
      return;
    }

    if (!calibrated) {
      LOG("SYS", "Calibrando ruido… (0.6s)");
      await calibrateNoise(650);
    }

    chunks = [];
    let options = {};
    const m1 = "audio/webm;codecs=opus";
    const m2 = "audio/webm";
    if (MediaRecorder.isTypeSupported?.(m1)) options.mimeType = m1;
    else if (MediaRecorder.isTypeSupported?.(m2)) options.mimeType = m2;

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

    mediaRecorder.onstop = async () => {
      try { if (rafId) cancelAnimationFrame(rafId); } catch {}
      rafId = null;
      VU(0);

      try { srcNode?.disconnect(); } catch {}
      srcNode = null;
      analyser = null;

      const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || "audio/webm" });
      stopTracks();

      if (!blob || blob.size < 1200) {
        LOG("SYS", "Habla al menos 1–2 segundos. Intenta de nuevo.");
        STATE("idle");
        return;
      }

      try {
        STATE("thinking");
        LOG("SYS", "STT…");
        const text = await window.VX_transcribeAudio(blob);
        const clean = (text || "").trim();
        LOG("YOU", clean || "(vacío)");

        if (!clean) {
          LOG("SYS", "No detecté voz clara. Cambia mic o acércate 2–3s.");
          STATE("idle");
          return;
        }

        LOG("SYS", "CHAT…");
        const reply = await window.VX_chatReply(clean);
        LOG("BOT", reply || "(sin respuesta)");

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
        STATE("idle");
      }
    };

    isRecording = true;
    STATE("listening");
    LOG("SYS", "Escuchando… (auto-stop por silencio)");
    startVuAndVadLoop();

    try {
      mediaRecorder.start(250);
    } catch (e) {
      console.error(e);
      STATE("error");
      alert("No pude iniciar la grabación.");
      isRecording = false;
      stopTracks();
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;

    try { if (rafId) cancelAnimationFrame(rafId); } catch {}
    rafId = null;
    VU(0);

    try {
      if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch (e) {
      console.error(e);
      stopTracks();
      STATE("idle");
    }
  }

  // Toggle (botón)
  window.VX_toggleTalk = async () => {
    if (!isRecording) await startRecording();
    else stopRecording();
  };

  console.log("✅ voiceRecorder loaded");
})();







