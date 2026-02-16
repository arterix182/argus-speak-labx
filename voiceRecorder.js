/* js/voiceRecorder.js
   Continuous call with auto-stop by silence + mic selector + meter.
*/
(function () {
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let deviceId = localStorage.getItem("VX_MIC") || "";
  let callActive = false;

  // audio meter
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let rafId = null;

  // tuneables
  const SILENCE_HOLD_MS = 700;     // ~0.7s
  const CALIBRATE_MS = 350;        // baseline noise sample
  const START_MULT = 2.2;          // start threshold factor
  const SILENCE_MULT = 1.6;        // silence threshold factor
  const MIN_START_ABS = 0.012;     // absolute floor to avoid never starting

  // UI hooks
  const onLog = (m) => window.VX_onLog && window.VX_onLog(m);
  const onState = (s) => window.VX_onState && window.VX_onState(s);

  function setMeter(pct) {
    const el = document.getElementById("meterFill");
    if (!el) return;
    el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  async function stopStream() {
    try {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      setMeter(0);

      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch {}

    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
    } catch {}
    stream = null;
    mediaRecorder = null;
    chunks = [];

    try {
      if (sourceNode) sourceNode.disconnect();
      if (analyser) analyser.disconnect();
    } catch {}
    sourceNode = null;
    analyser = null;

    try {
      if (audioCtx) await audioCtx.close();
    } catch {}
    audioCtx = null;
  }

  async function ensureStream() {
    // Siempre creamos stream nuevo cuando arrancas para evitar el bug “2do intento”
    await stopStream();

    const constraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;

    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(analyser);
  }

  function rmsFromAnalyser() {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length); // 0..~1
  }

  async function calibrateNoise() {
    const t0 = performance.now();
    let n = 0, acc = 0;

    while (performance.now() - t0 < CALIBRATE_MS) {
      const v = rmsFromAnalyser();
      acc += v;
      n++;
      await new Promise(r => setTimeout(r, 20));
    }
    const noise = (acc / Math.max(1, n)) || 0.004;
    return noise;
  }

  function startMeterLoop() {
    const loop = () => {
      if (!callActive || !analyser) return;
      const v = rmsFromAnalyser();         // 0..1
      const pct = Math.min(100, v * 2500); // escala visual
      setMeter(pct);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }

  function recordOnce() {
    return new Promise((resolve, reject) => {
      chunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");

      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onerror = (e) => reject(e.error || new Error("MediaRecorder error"));
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime || "audio/webm" });
        resolve(blob);
      };
      mediaRecorder.start();
    });
  }

  async function waitForSpeechAndAutoStop(noise) {
    // thresholds
    const startTh = Math.max(MIN_START_ABS, noise * START_MULT);
    const silenceTh = Math.max(MIN_START_ABS * 0.8, noise * SILENCE_MULT);

    onLog(`SYS: Calibrado. ruido=${noise.toFixed(3)} start=${startTh.toFixed(3)} silence=${silenceTh.toFixed(3)}`);

    // wait until speaking starts (crosses startTh)
    let started = false;
    let lastLoud = performance.now();

    while (callActive) {
      const v = rmsFromAnalyser();

      if (!started) {
        if (v >= startTh) {
          started = true;
          onLog("SYS: Detecté voz. Grabando…");
          onState("listening");
          lastLoud = performance.now();
          break;
        }
      }
      await new Promise(r => setTimeout(r, 30));
    }

    if (!callActive) return { started: false };

    // Now we are in "speaking started", we stop when silent for SILENCE_HOLD_MS
    while (callActive) {
      const v = rmsFromAnalyser();
      const now = performance.now();

      if (v >= silenceTh) lastLoud = now;

      if (now - lastLoud > SILENCE_HOLD_MS) {
        onLog("SYS: Auto-stop por silencio.");
        return { started: true };
      }
      await new Promise(r => setTimeout(r, 30));
    }

    return { started: started };
  }

  async function runOneTurn() {
    // 1) ensure stream + meter
    await ensureStream();
    startMeterLoop();

    // 2) calibrate
    onState("listening");
    onLog("SYS: Escuchando… (silencio = stop)");
    const noise = await calibrateNoise();

    // 3) start recorder NOW, then wait speech, then stop
    const recPromise = recordOnce();

    const gate = await waitForSpeechAndAutoStop(noise);
    if (!gate.started) {
      // Stop everything if never started
      await stopStream();
      onState("idle");
      onLog("SYS: No detecté voz. Intenta de nuevo.");
      return;
    }

    // stop recorder
    try { mediaRecorder.stop(); } catch {}
    const blob = await recPromise;

    // 4) pipeline
    onLog("SYS: STT...");
    onState("thinking");
    const text = await window.VX_transcribeAudio(blob);

    const clean = (text || "").trim();
    onLog("YOU: " + (clean || "(vacío)"));
    if (!clean) {
      onState("idle");
      onLog("SYS: Habla 1–2s. Intenta de nuevo.");
      return;
    }

    onLog("SYS: CHAT...");
    const modeSel = document.getElementById("modeSelect");
    const mode = modeSel ? modeSel.value : "coach";
    const reply = await window.VX_chatReply(clean, { mode });

    onLog("BOT: " + reply);

    onLog("SYS: TTS...");
    onState("speaking");
    const audioBuf = await window.VX_ttsAudio(reply);

    await window.VX_playAudio(audioBuf);

    onState("idle");
  }

  // ===== Public API =====
  async function VX_callStart() {
    if (callActive) return;
    callActive = true;
    onLog("SYS: 📞 Llamada iniciada.");
    onState("listening");

    // loop until user stops
    while (callActive) {
      try {
        await runOneTurn();
        // pequeño respiro para que el browser suelte recursos
        await new Promise(r => setTimeout(r, 120));
      } catch (e) {
        onLog("SYS: ERROR: " + (e && e.message ? e.message : String(e)));
        // si falla un turno, seguimos (call continúa)
        onState("idle");
        await new Promise(r => setTimeout(r, 250));
      }
    }
    await stopStream();
    onState("idle");
    onLog("SYS: 📴 Llamada detenida.");
  }

  async function VX_callStop() {
    callActive = false;
    await stopStream();
    onState("idle");
    onLog("SYS: 📴 Llamada detenida.");
  }

  function VX_setMic(id) {
    deviceId = id || "";
  }

  async function VX_refreshMics() {
    const sel = document.getElementById("micSelect");
    if (!sel) return;

    // pide permiso para que salgan labels
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
    } catch (e) {
      sel.innerHTML = `<option value="">Permite micrófono</option>`;
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    sel.innerHTML = "";

    if (!mics.length) {
      sel.innerHTML = `<option value="">No se detectan micrófonos</option>`;
      return;
    }

    const saved = localStorage.getItem("VX_MIC") || "";
    for (const m of mics) {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label || `Mic ${mics.indexOf(m) + 1}`;
      if (saved && m.deviceId === saved) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  // Exports + aliases (para que el index no se rompa jamás)
  window.VX_callStart = VX_callStart;
  window.VX_callStop = VX_callStop;
  window.VX_setMic = VX_setMic;
  window.VX_refreshMics = VX_refreshMics;

  // device hotplug
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    VX_refreshMics().catch(()=>{});
  });

  console.log("✅ voiceRecorder loaded", {
    callStart: typeof window.VX_callStart,
    callStop: typeof window.VX_callStop,
    setMic: typeof window.VX_setMic,
    refreshMics: typeof window.VX_refreshMics
  });
})();


