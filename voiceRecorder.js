// voiceRecorder.js (COMPLETO - Push-to-talk + click fallback)
// Requiere: voicePipeline.js cargado antes (VX_transcribeAudio, VX_chatReply, VX_ttsAudio, VX_playAudio)

let VX_stream = null;
let VX_rec = null;
let VX_chunks = [];
let VX_deviceId = localStorage.getItem("VX_MIC") || "";

let VX_audioCtx = null;
let VX_analyser = null;
let VX_meterRAF = null;

let VX_isRecording = false;
let VX_autoStopTimer = null;

function VX_logErr(e){ console.error(e); }

async function VX_getStream() {
  const constraints = {
    audio: VX_deviceId ? { deviceId: { exact: VX_deviceId } } : true
  };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

async function VX_listMics() {
  // Pedimos permiso para ver labels (si falla, igual listamos)
  await navigator.mediaDevices.getUserMedia({ audio: true })
    .then(s => s.getTracks().forEach(t => t.stop()))
    .catch(()=>{});
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
      let sum = 0;
      for(let i=0;i<data.length;i++){
        const v = (data[i]-128)/128;
        sum += v*v;
      }
      const rms = Math.sqrt(sum/data.length);
      if(typeof window.VX_onMeter === "function") window.VX_onMeter(Math.min(1, rms*3.2));
      VX_meterRAF = requestAnimationFrame(tick);
    };
    VX_meterRAF = requestAnimationFrame(tick);
  }catch(e){ VX_logErr(e); }
}

function VX_stopMeter(){
  if(VX_meterRAF) cancelAnimationFrame(VX_meterRAF);
  VX_meterRAF = null;
  VX_analyser = null;
}

function VX_killAutoStop(){
  if(VX_autoStopTimer) clearTimeout(VX_autoStopTimer);
  VX_autoStopTimer = null;
}

// 🔥 Seguridad: nunca más de X segundos grabando
function VX_armHardAutoStop(ms = 12000){
  VX_killAutoStop();
  VX_autoStopTimer = setTimeout(()=>{
    if(VX_isRecording){
      console.warn("Auto-stop hard limit reached");
      // Detenemos sin UI; la UI lo maneja afuera
      window.VX_stopRecordingAndRun?.({ mode:"coach", onLog:()=>{}, onState:()=>{} }).catch(console.error);
    }
  }, ms);
}

async function startRecording() {
  if (VX_isRecording) return;
  VX_isRecording = true;

  VX_chunks = [];
  VX_stream = await VX_getStream();
  VX_startMeter(VX_stream);

  VX_rec = new MediaRecorder(VX_stream, { mimeType: "audio/webm" });
  VX_rec.ondataavailable = (ev)=>{
    if(ev.data && ev.data.size) VX_chunks.push(ev.data);
  };

  VX_rec.start(200); // chunk cada 200ms
  VX_armHardAutoStop(12000); // 12s máximo (ajústalo si quieres)
}

async function stopRecording() {
  if (!VX_isRecording) return null;
  VX_isRecording = false;
  VX_killAutoStop();

  if(!VX_rec) return null;
  if(VX_rec.state !== "recording") return null;

  const blob = await new Promise((resolve, reject)=>{
    VX_rec.onstop = ()=>{
      try{
        resolve(new Blob(VX_chunks, { type: "audio/webm" }));
      }catch(e){ reject(e); }
    };
    try{ VX_rec.stop(); } catch(e){ reject(e); }
  });

  // Stop stream
  try{
    VX_stopMeter();
    VX_stream?.getTracks()?.forEach(t=>t.stop());
  }catch(e){}

  return blob;
}

async function stopRecordingAndRun({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}) {
  const blob = await stopRecording();
  if(!blob) throw new Error("No audio captured");

  onState("thinking");
  onLog("SYS: STT…");
  const text = await window.VX_transcribeAudio(blob);

  const clean = (text || "").trim();
  if(!clean){
    onState("idle");
    onLog("SYS: Habla al menos 1 segundo. Intenta de nuevo.");
    return;
  }

  onLog("YOU: " + clean);

  onLog("SYS: CHAT…");
  const prompt = VX_buildPrompt(mode, clean);
  const reply = await window.VX_chatReply(prompt);
  onLog("BOT: " + reply);

  onLog("SYS: TTS…");
  const audio = await window.VX_ttsAudio(reply);
  await window.VX_playAudio(audio);

  onState("idle");
}

function VX_buildPrompt(mode, userText){
  const base = `Eres un coach de inglés. Responde en español, corrige la frase del usuario y da 2 ejemplos en inglés.`;
  const styles = {
    coach: "Sé motivador, directo y práctico.",
    friendly: "Sé amable y breve.",
    strict: "Sé exigente y específico."
  };
  return `${base}\nEstilo: ${styles[mode] || styles.coach}\nUsuario dijo: "${userText}"`;
}

// === Export GLOBAL API (lo que tu index necesita) ===
window.VX_startRecording = startRecording;
window.VX_stopRecordingAndRun = stopRecordingAndRun;
window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;

console.log("✅ voiceRecorder loaded", {
  VX_startRecording: typeof window.VX_startRecording,
  VX_stopRecordingAndRun: typeof window.VX_stopRecordingAndRun
});







