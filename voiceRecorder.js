/* /js/voiceRecorder.js
   Grabación + selección de micrófono (robusto).
   Exporta funciones globales VX_* para tu app.
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

  // ====== UTILIDADES ======
  function logSYS(msg) {
    // Si tienes tu logger propio, puedes reemplazar esto.
    // Mantengo console para que siempre exista.
    console.log(`[VX] ${msg}`);
    if (window.appendLog) window.appendLog(`SYS: ${msg}`);
  }

  function logERR(msg, err) {
    console.error(`[VX] ${msg}`, err || "");
    if (window.appendLog) window.appendLog(`SYS: ERROR: ${msg}${err ? " | " + (err.message || err) : ""}`);
  }

  async function safeStopStream(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach(t => t.stop());
    } catch (e) {}
  }

  async function requestMicPermission() {
    // Esto es CLAVE: sin permiso, enumerateDevices no muestra labels.
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

  async function buildAudioConstraints(deviceId) {
    // Mantén simple: deviceId si se proporciona.
    if (!deviceId) return { audio: true };
    return { audio: { deviceId: { exact: deviceId } } };
  }

  async function startStream(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia() no está disponible en este navegador.");
    }

    // Detener lo anterior
    await safeStopStream(state.stream);
    state.stream = null;

    const constraints = await buildAudioConstraints(deviceId);

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;

    // deviceId real (a veces el browser asigna otro)
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() || {};
    state.currentDeviceId = settings.deviceId || deviceId || null;

    return stream;
  }

  function canRecord() {
    return typeof MediaRecorder !== "undefined";
  }

  function makeRecorder(stream) {
    if (!canRecord()) throw new Error("MediaRecorder no está soportado en este navegador.");

    // Algunos navegadores requieren mimeType compatible. Probamos opciones.
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

    mr.onerror = (e) => {
      logERR("MediaRecorder error.", e?.error || e);
    };

    mr.onstart = () => logSYS("Grabación iniciada.");
    mr.onstop = () => logSYS("Grabación detenida.");

    return mr;
  }

  function getBlob() {
    if (!state.chunks.length) return null;
    const type = (state.mediaRecorder && state.mediaRecorder.mimeType) || "audio/webm";
    return new Blob(state.chunks, { type });
  }

  // ====== API GLOBAL ======
  window.VX_refreshMics = async function VX_refreshMics() {
    logSYS("VX_refreshMics()");
    const ok = await requestMicPermission();
    if (!ok) return { ok: false, error: "permission_denied", mics: [] };

    const mics = await listMics();

    // Normaliza nombres
    const clean = mics.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${idx + 1}`,
      groupId: d.groupId || null,
    }));

    logSYS(`Micrófonos detectados: ${clean.length}`);
    return { ok: true, mics: clean };
  };

  // Inicia grabación (opcional: deviceId)
  window.VX_callStart = async function VX_callStart(deviceId = null) {
    try {
      logSYS(`VX_callStart(${deviceId || "default"})`);

      const ok = await requestMicPermission();
      if (!ok) return { ok: false, error: "permission_denied" };

      const stream = await startStream(deviceId);

      // Si tu app solo quiere "usar micrófono" sin grabar, puedes omitir recorder.
      state.mediaRecorder = makeRecorder(stream);
      state.mediaRecorder.start(250); // chunk cada 250ms
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

  // Detiene grabación y devuelve blob
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

      const stopped = new Promise((resolve) => {
        mr.onstop = () => resolve(true);
      });

      if (mr.state !== "inactive") mr.stop();
      await stopped;

      const blob = getBlob();
      const mimeType = mr.mimeType || (blob ? blob.type : null);

      state.mediaRecorder = null;
      state.isRecording = false;

      await safeStopStream(state.stream);
      state.stream = null;

      return { ok: true, blob, mimeType };
    } catch (e) {
      logERR("VX_callStop falló.", e);
      state.mediaRecorder = null;
      state.isRecording = false;
      await safeStopStream(state.stream);
      state.stream = null;
      return { ok: false, error: e.message || String(e) };
    }
  };

  // Auto-log para confirmar carga correcta
  logSYS("voiceRecorder.js cargado ✅ (VX_callStart/VX_callStop/VX_refreshMics listos)");
})();












