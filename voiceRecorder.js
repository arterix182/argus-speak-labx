// voiceRecorder.js (COMPLETO)
// Requiere que voicePipeline.js ya cargó (para VX_transcribeAudio, VX_chatReply, VX_ttsAudio, VX_playAudio)

let VX_stream = null;
let VX_rec = null;
let VX_chunks = [];
let VX_deviceId = localStorage.getItem("VX_MIC") || "";
let VX_audioCtx = null;
let VX_analyser = null;
let VX_meterRAF = null;

function VX_logErr(e){ console.error(e); }

async function VX_getStream() {
  // Importante: si hay deviceId guardado, lo usamos
  const constraints = {
    audio: VX_deviceId ? { deviceId: { exact: VX_deviceId } } : true
  };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

async function VX_listMics() {
  // Necesita permiso para ver labels; si no hay permiso, labels vacíos
  await navigator.mediaDevices.getUserMedia({ audio: true }).then(s=>s.getTracks().forEach(t=>t.stop())).catch(()=>{});
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === "audioinput");
}

function VX_setMic(deviceId) {
  VX_deviceId = deviceId || "";
  localStorage.setItem("VX_MIC", VX_deviceId);
}

function VX_startMeter(stream){
  try{
    VX_audioCtx = VX_audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = VX_audioCtx.createMediaStreamSource(stream);
    VX_analyser = VX_audioCtx.createAnalyser();
    VX_analyser.fftSize = 512;
    src.connect(VX_analyser);

    const data = new Uint8Array(VX_analyser.frequencyBinCount);

    const tick = ()=>{
      VX_analyser.getByteTimeDomainData(data);
      // RMS simple
      let sum = 0;
      for(let i=0;i<data.length;i++){
        const v = (data[i]-128)/128;
        sum += v*v;
      }
      const rms = Math.sqrt(sum/data.length); // 0..~1
      if(typeof window.VX_onMeter === "function") window.VX_onMeter(Math.min(1, rms*3.2));
      VX_meterRAF = requestAnimationFrame(tick);
    };
    VX_meterRAF = requestAnimationFrame(tick);
  }catch(e){
    VX_logErr(e);
  }
}

function VX_stopMeter(){
  if(VX_meterRAF) cancelAnimationFrame(VX_meterRAF);
  VX_meterRAF = null;
  VX_analyser = null;
  // No cerramos AudioContext para evitar pops
}

async function startRecording() {
  if (VX_rec && VX_rec.state === "recording") return;

  VX_chunks = [];
  VX_stream = await VX_getStream();

  VX_startMeter(VX_stream);

  VX_rec = new MediaRecorder(VX_stream, { mimeType: "audio/webm" });
  VX_rec.ondataavailable = (ev)=>{
    if(ev.data && ev.data.size) VX_chunks.push(ev.data);
  };
  VX_rec.start(250); // cada 250ms
}

async function stopRecordingAndRun({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}) {
  if(!VX_rec) throw new Error("Recorder not started");
  if(VX_rec.state !== "recording") throw new Error("Recorder not recording");

  const blob = await new Promise((resolve, reject)=>{
    VX_rec.onstop = ()=>{
      try{
        const b = new Blob(VX_chunks, { type: "audio/webm" });
        resolve(b);
      }catch(e){ reject(e); }
    };
    VX_rec.stop();
  });

  // Stop stream
  try{
    VX_stopMeter();
    VX_stream?.getTracks()?.forEach(t=>t.stop());
  }catch(e){}

  // Pipeline
  onState("thinking");
  onLog("SYS: STT…");
  const text = await window.VX_transcribeAudio(blob);
  onLog("YOU: " + text);

  onLog("SYS: CHAT…");
  const prompt = VX_buildPrompt(mode, text);
  const reply = await window.VX_chatReply(prompt);
  onLog("BOT: " + reply);

  onLog("SYS: TTS…");
  const audio = await window.VX_ttsAudio(reply);
  await window.VX_playAudio(audio);

  onState("idle");
}

function VX_buildPrompt(mode, userText){
  const base = `Eres un coach de inglés. Responde en español y da corrección y 2 ejemplos en inglés.`;
  const styles = {
    coach: "Sé motivador, directo, y enfocado a mejora.",
    friendly: "Sé amable, simple, y corto.",
    strict: "Sé exigente y específico, corrige sin suavizar demasiado."
  };
  return `${base}\nEstilo: ${styles[mode] || styles.coach}\nUsuario dijo: "${userText}"`;
}

// === Export GLOBAL API (esto es lo que te faltaba) ===
window.VX_startRecording = startRecording;
window.VX_stopRecordingAndRun = stopRecordingAndRun;
window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;

console.log("✅ voiceRecorder loaded", {
  VX_startRecording: typeof window.VX_startRecording,
  VX_stopRecordingAndRun: typeof window.VX_stopRecordingAndRun
});







