/* voiceRecorder.js
   Grabación + selección de micrófono (robusto) con fallback cuando el deviceId exacto falla.
*/
(() => {
  "use strict";

  const state = {
    stream: null,
    mediaRecorder: null,
    chunks: [],
    currentDeviceId: null,
    isRecording: false,
    lastDevices: [],
  };

  function logSYS(msg) {
    console.log(`[VX] ${msg}`);
    if (window.appendLog) window.appendLog(`SYS: ${msg}`);
  }

  function logERR(msg, err) {
    console.error(`[VX] ${msg}`, err || "");
    if (window.appendLog) window.appendLog(`SYS: ERROR: ${msg}${err ? " | " + (err.message || err) : ""}`);
  }

  async function safeStopStream(stream) {
    if (!stream) return;
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
  }

  async function requestMicPermission() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      await safeStopStream(tmp);
      return true;
    } catch (e) {
      logERR("Permiso de micrófono DENEGADO o bloqueado.", e);
      return false;
    }
  }

  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      logERR("Tu navegador no soporta enumerateDevices().");
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    state.lastDevices = mics;
    return mics;
  }

  function canRecord() {
    return typeof MediaRecorder !== "undefined";
  }

  function makeRecorder(stream) {
    if (!canRecord()) throw new Error("MediaRecorder no está soportado en este navegador.");

    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];

    let options = {};
    for (const mt of preferred) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mt)) {
        options = { mimeType: mt };
        break;
      }
    }

    const mr = new MediaRecorder(stream, options);
    state.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    };

    mr.onerror = (e) => logERR("MediaRecorder error.", e?.error || e);
    mr.onstart = () => logSYS("Grabación iniciada.");
    mr.onstop  = () => logSYS("Grabación detenida.");

    return mr;
  }

  function getBlob() {
    if (!state.chunks.length) return null;
    const type = (state.mediaRecorder && state.mediaRecorder.mimeType) || "audio/webm";
    return new Blob(state.chunks, { type });
  }

  async function startStreamWithFallback(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia() no está disponible en este navegador.");
    }

    await safeStopStream(state.stream);
    state.stream = null;

    // 1) Intento con deviceId exacto (solo si viene uno real)
    if (deviceId && deviceId !== "default" && deviceId !== "communications") {
      try {
        const streamExact = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } }
        });
        state.stream = streamExact;
        const track = streamExact.getAudioTracks()[0];
        const settings = track?.getSettings?.() || {};
        state.currentDeviceId = settings.deviceId || deviceId || null;
        return streamExact;
      } catch (e) {
        // ✅ Aquí está el cambio: si falla por overconstrained/notfound, hacemos fallback
        if (e?.name === "OverconstrainedError" || e?.name === "NotFoundError") {
          logSYS(`Mic exacto no disponible (${e.name}). Fallback a mic por defecto.`);
        } else {
          throw e; // otros errores sí los respetamos
        }
      }
    }

    // 2) Fallback: audio:true (el navegador elige)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.stream = stream;

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() || {};
    state.currentDeviceId = settings.deviceId || null;

    return stream;
  }

  // ====== API GLOBAL ======
  window.VX_refreshMics = async function VX_refreshMics() {
    logSYS("VX_refreshMics()");
    const ok = await requestMicPermission();
    if (!ok) return { ok: false, error: "permission_denied", mics: [] };

    const mics = await listMics();
    const clean = mics.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${idx + 1}`,
      groupId: d.groupId || null,
    }));

    logSYS(`Micrófonos detectados: ${clean.length}`);
    return { ok: true, mics: clean };
  };

  window.VX_callStart = async function VX_callStart(deviceId = null) {
    try {
      logSYS(`VX_callStart(${deviceId || "default"})`);

      const ok = await requestMicPermission();
      if (!ok) return { ok: false, error: "permission_denied" };

      const stream = await startStreamWithFallback(deviceId);

      state.mediaRecorder = makeRecorder(stream);
      state.mediaRecorder.start(250);
      state.isRecording = true;

      return {
        ok: true,
        deviceId: state.currentDeviceId,
        mimeType: state.mediaRecorder.mimeType,
      };
    } catch (e) {
      state.isRecording = false;
      await safeStopStream(state.stream);
      state.stream = null;
      logERR("VX_callStart falló.", e);
      return { ok: false, error: e.message || String(e) };
    }
  };

  window.VX_callStop = async function VX_callStop() {
    try {
      logSYS("VX_callStop()");
      if (!state.mediaRecorder) {
        logSYS("No hay MediaRecorder activo.");
        await safeStopStream(state.stream);
        state.stream = null;
        state.isRecording = false;
        return { ok: true, blob: null, mimeType: null };
      }

      const mr = state.mediaRecorder;
      const stopped = new Promise((resolve) => { mr.onstop = () => resolve(true); });












