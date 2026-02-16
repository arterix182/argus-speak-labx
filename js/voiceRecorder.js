/* voiceRecorder.js (DEFAULT MIC ONLY)
   Siempre usa el micrófono disponible del dispositivo:
   navigator.mediaDevices.getUserMedia({ audio: true })

   Expone:
     - VX_callStart()
     - VX_callStop()
   Callbacks:
     - window.VX_onLog(msg)
     - window.VX_onState(state)
*/
(() => {
  "use strict";

  const state = {
    stream: null,
    mediaRecorder: null,
    chunks: [],
    isRecording: false,
  };

  function log(msg){
    console.log("[VX]", msg);
    if (typeof window.VX_onLog === "function") window.VX_onLog(msg);
  }

  async function setState(s){
    if (typeof window.VX_onState === "function"){
      try { await window.VX_onState(s); } catch {}
    }
  }

  async function stopStream(){
    if (!state.stream) return;
    try { state.stream.getTracks().forEach(t => t.stop()); } catch {}
    state.stream = null;
  }

  function chooseRecorderOptions(){
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];
    for (const mt of preferred){
      if (window.MediaRecorder?.isTypeSupported?.(mt)) return { mimeType: mt };
    }
    return {};
  }

  function makeRecorder(stream){
    if (typeof MediaRecorder === "undefined"){
      throw new Error("MediaRecorder no está soportado en este navegador.");
    }
    const mr = new MediaRecorder(stream, chooseRecorderOptions());
    state.chunks = [];

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.chunks.push(e.data);
    };
    mr.onerror = (e) => log("SYS: ERROR MediaRecorder: " + (e?.error?.message || e?.message || e));

    return mr;
  }

  function getBlob(){
    if (!state.chunks.length) return null;
    const type = state.mediaRecorder?.mimeType || "audio/webm";
    return new Blob(state.chunks, { type });
  }

  async function getDefaultMicStream(){
    // ✅ Siempre default mic (más robusto)
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  window.VX_callStart = async function VX_callStart(){
    try{
      log("SYS: VX_callStart (default mic)");
      await setState("listening");

      // Permiso
      if (!navigator.mediaDevices?.getUserMedia){
        throw new Error("getUserMedia() no disponible.");
      }

      await stopStream();
      state.stream = await getDefaultMicStream();

      state.mediaRecorder = makeRecorder(state.stream);
      state.mediaRecorder.start(250);
      state.isRecording = true;

      log("SYS: Grabación iniciada ✅ (default mic)");
      return { ok:true, mimeType: state.mediaRecorder.mimeType };

    }catch(e){
      log("SYS: ERROR VX_callStart: " + (e?.message || e));
      state.isRecording = false;
      state.mediaRecorder = null;
      await stopStream();
      await setState("idle");
      throw e;
    }
  };

  window.VX_callStop = async function VX_callStop(){
    try{
      log("SYS: VX_callStop");
      if (!state.mediaRecorder){
        await stopStream();
        state.isRecording = false;
        await setState("idle");
        return { ok:true, blob:null, mimeType:null };
      }

      const mr = state.mediaRecorder;
      const stopped = new Promise((resolve) => { mr.onstop = () => resolve(true); });

      if (mr.state !== "inactive") mr.stop();
      await stopped;

      const blob = getBlob();
      const mimeType = mr.mimeType || (blob ? blob.type : null);

      state.mediaRecorder = null;
      state.isRecording = false;
      await stopStream();
      await setState("idle");

      log("SYS: Grabación detenida ✅");
      return { ok:true, blob, mimeType };

    }catch(e){
      log("SYS: ERROR VX_callStop: " + (e?.message || e));
      state.mediaRecorder = null;
      state.isRecording = false;
      await stopStream();
      await setState("idle");
      return { ok:false, error: e?.message || String(e) };
    }
  };

  // Ya no usamos selección de mic
  window.VX_refreshMics = async () => ({ ok:true, mics:[] });
  window.VX_setMic = () => {};

  log("SYS: voiceRecorder.js cargado ✅ (default mic only)");
})();
