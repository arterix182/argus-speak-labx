/* voiceRecorder.js
   Grabación + selección de micrófono (robusto) con fallback cuando deviceId exact falla.
   Expone:
     - VX_refreshMics() -> {ok, mics}
     - VX_setMic(deviceId)
     - VX_callStart(deviceId?)
     - VX_callStop()
   Callbacks (si existen):
     - window.VX_onLog(msg)
     - window.VX_onState(state)
*/
(() => {
  "use strict";

  const state = {
    stream: null,
    mediaRecorder: null,
    chunks: [],
    currentDeviceId: "",
    chosenDeviceId: "",
    isRecording: false,
  };

  function logSYS(msg) {
    console.log(`[VX] ${msg}`);
    if (typeof window.VX_onLog === "function") window.VX_onLog(`SYS: ${msg}`);
  }

  function logERR(msg, err) {
    console.error(`[VX] ${msg}`, err || "");
    if (typeof window.VX_onLog === "function") window.VX_onLog(`SYS: ERROR: ${msg}${err ? " | " + (err.message || err) : ""}`);
  }

  async function setState(s) {
    if (typeof window.VX_onState === "function") {
      try { await window.VX_onState(s); } catch {}
    }
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

  async function listMicsRaw() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "audioinput");
  }

  function chooseRecorderOptions() {
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
    return options;
  }

  function makeRecorder(stream) {
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder no está soportado en este navegador.");
    }

    const mr = new MediaRecorder(stream, chooseRecorderOptions());
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

    // 1) Intento exacto si nos dieron deviceId
    if (deviceId && deviceId !== "default" && deviceId !== "communications") {
      try {
        const sExact = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } }
        });
        state.stream = sExact;

        const track = sExact.getAudioTracks()?.[0];
        const settings = track?.getSettings?.() || {};
        state.currentDeviceId = settings.deviceId || deviceId || "";
        return sExact;
      } catch (e) {
        // ✅ fallback si exact no existe
        if (e?.name === "OverconstrainedError" || e?.name === "NotFoundError") {
          logSYS(`Mic exacto no disponible (${e.name}). Fallback a mic por defecto.`);
        } else {
          throw e;
        }
      }
    }

    // 2) Fallback: audio:true
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.stream = s;

    const track = s.getAudioTracks()?.[0];
    const settings = track?.getSettings?.() || {};
    state.currentDeviceId = settings.deviceId || "";
    return s;
  }

  // ===== API =====

  window.VX_refreshMics = async function VX_refreshMics() {
    logSYS("Actualizando lista de micrófonos…");

    const ok = await requestMicPermission();
    if (!ok) return { ok: false, error: "permission_denied", mics: [] };

    const raw = await listMicsRaw();
    const clean = raw.map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Micrófono ${idx + 1}`,
      groupId: d.groupId || ""
    }));

    logSYS(`Micrófonos detectados: ${clean.length}`);
    return { ok: true, mics: clean };
  };

  window.VX_setMic = function VX_setMic(deviceId) {
    state.chosenDeviceId = deviceId || "";
    logSYS(`Mic set: ${state.chosenDeviceId || "default"}`);
  };

  window.VX_callStart = async function VX_callStart(deviceId = "") {
    try {
      const want = deviceId || state.chosenDeviceId || "";
      logSYS(`VX_callStart(${want || "default"})`);

      await setState("listening");

      const ok = await requestMicPermission();
      if (!ok) throw new Error("Permiso de micrófono bloqueado.");

      const stream = await startStreamWithFallback(want);

      state.mediaRecorder = makeRecorder(stream);
      state.mediaRecorder.start(250);
      state.isRecording = true;

      return { ok: true, deviceId: state.currentDeviceId, mimeType: state.mediaRecorder.mimeType };
    } catch (e) {
      state.isRecording = false;
      await safeStopStream(state.stream);
      state.stream = null;
      await setState("idle");
      logERR("VX_callStart falló.", e);
      throw e;
    }
  };

  window.VX_callStop = async function VX_callStop() {
    try {
      logSYS("VX_callStop()");
      if (!state.mediaRecorder) {
        await safeStopStream(state.stream);
        state.stream = null;
        state.isRecording = false;
        await setState("idle");
        return { ok: true, blob: null, mimeType: null };
      }

      const mr = state.mediaRecorder;
      const stopped = new Promise((resolve) => { mr.onstop = () => resolve(true); });

      if (mr.state !== "inactive") mr.stop();
      await stopped;

      const blob = getBlob();
      const mimeType = mr.mimeType || (blob ? blob.type : null);

      state.mediaRecorder = null;
      state.isRecording = false;

      await safeStopStream(state.stream);
      state.stream = null;

      await setState("idle");
      return { ok: true, blob, mimeType };
    } catch (e) {
      logERR("VX_callStop falló.", e);
      state.mediaRecorder = null;
      state.isRecording = false;
      await safeStopStream(state.stream);
      state.stream = null;
      await setState("idle");
      return { ok: false, error: e.message || String(e) };
    }
  };

  logSYS("voiceRecorder.js cargado ✅ (fallback Overconstrained listo)");
})();









