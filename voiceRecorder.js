// voiceRecorder.js (COMPLETO - AutoStop PRO v2)
// Fix: segundo intento sin voz / barra muerta por AudioContext suspendido y nodos colgados.
// Requiere voicePipeline.js antes: VX_transcribeAudio, VX_chatReply, VX_ttsAudio, VX_playAudio

let VX_deviceId = localStorage.getItem("VX_MIC") || "";

let VX_stream = null;
let VX_rec = null;
let VX_chunks = [];

let VX_audioCtx = null;
let VX_srcNode = null;
let VX_analyser = null;
let VX_meterRAF = null;

let VX_state = "idle"; // idle | recording | processing
let VX_stopRequested = false;

// ===== Ajustes VAD (silencio) =====
const VX_CFG = {
  chunkMs: 200,
  hardMaxMs: 12000,
  calibrateMs: 500,
  startMargin: 0.020,
  silenceMargin: 0.012,
  minSpeechMs: 250,
  silenceHoldMs: 700
};

function VX_sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function VX_now(){ return performance.now(); }

async function VX_getStream(){
  const constraints = { audio: VX_deviceId ? { deviceId: { exact: VX_deviceId } } : true };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

async function VX_listMics(){
  await navigator.mediaDevices.getUserMedia({audio:true})
    .then(s=>s.getTracks().forEach(t=>t.stop()))
    .catch(()=>{});
  const d = await navigator.mediaDevices.enumerateDevices();
  return d.filter(x=>x.kind==="audioinput");
}

function VX_setMic(id){
  VX_deviceId = id || "";
  localStorage.setItem("VX_MIC", VX_deviceId);
}

// ===== Audio / Meter =====
function VX_ensureAudioCtx(){
  if(!VX_audioCtx) VX_audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return VX_audioCtx;
}

async function VX_resumeAudioCtx(){
  const ctx = VX_ensureAudioCtx();
  // IMPORTANT: en muchos navegadores se suspende después de parar tracks
  if(ctx.state === "suspended") {
    try { await ctx.resume(); } catch(e) {}
  }
}

function VX_disconnectNodes(){
  try { VX_srcNode?.disconnect(); } catch(e) {}
  try { VX_analyser?.disconnect(); } catch(e) {}
  VX_srcNode = null;
  VX_analyser = null;
}

function VX_startAnalyser(stream){
  VX_disconnectNodes();
  const ctx = VX_ensureAudioCtx();
  VX_srcNode = ctx.createMediaStreamSource(stream);
  VX_analyser = ctx.createAnalyser();
  VX_analyser.fftSize = 512;
  VX_srcNode.connect(VX_analyser);
}

function VX_getRms(){
  if(!VX_analyser) return 0;
  const data = new Uint8Array(VX_analyser.frequencyBinCount);
  VX_analyser.getByteTimeDomainData(data);
  let sum=0;
  for(let i=0;i<data.length;i++){
    const v=(data[i]-128)/128;
    sum += v*v;
  }
  return Math.sqrt(sum/data.length);
}

function VX_startMeterLoop(){
  VX_stopMeterLoop();
  const tick=()=>{
    const rms = VX_getRms();
    if(typeof window.VX_onMeter==="function") window.VX_onMeter(Math.min(1, rms*3.2));
    VX_meterRAF = requestAnimationFrame(tick);
  };
  VX_meterRAF = requestAnimationFrame(tick);
}

function VX_stopMeterLoop(){
  if(VX_meterRAF) cancelAnimationFrame(VX_meterRAF);
  VX_meterRAF = null;
  if(typeof window.VX_onMeter==="function") window.VX_onMeter(0); // reset barra
}

// ===== Cleanup =====
function VX_cleanupAll(){
  try{
    VX_stopMeterLoop();
    VX_disconnectNodes();
    if(VX_stream){
      VX_stream.getTracks().forEach(t=>t.stop());
    }
  }catch(e){}
  VX_stream = null;
  VX_rec = null;
  VX_chunks = [];
  VX_stopRequested = false;
}

async function VX_safeStopRecorder(){
  if(!VX_rec) return null;
  const rec = VX_rec;

  if(rec.state !== "recording") return null;

  const blob = await new Promise((resolve)=>{
    let done=false;
    const kill = setTimeout(()=>{
      if(done) return;
      done=true;
      resolve(null);
    }, 1500);

    rec.onstop = ()=>{
      if(done) return;
      done=true;
      clearTimeout(kill);
      try{
        resolve(new Blob(VX_chunks, { type:"audio/webm" }));
      }catch(e){
        resolve(null);
      }
    };

    try{ rec.stop(); } catch(e){ clearTimeout(kill); resolve(null); }
  });

  return blob;
}

// ===== Core: start/stop recording =====
async function VX_startRecordingInternal(){
  if(VX_state !== "idle") return;
  VX_state = "recording";
  VX_stopRequested = false;
  VX_chunks = [];

  // Reanuda AudioContext (CLAVE para que el RMS no se quede en 0 en el segundo intento)
  await VX_resumeAudioCtx();

  VX_stream = await VX_getStream();
  VX_startAnalyser(VX_stream);
  VX_startMeterLoop();

  VX_rec = new MediaRecorder(VX_stream, { mimeType: "audio/webm" });
  VX_rec.ondataavailable = (ev)=>{ if(ev.data && ev.data.size) VX_chunks.push(ev.data); };
  VX_rec.start(VX_CFG.chunkMs);
}

async function VX_stopRecordingInternal(){
  if(VX_state !== "recording") return null;
  VX_state = "processing";

  const blob = await VX_safeStopRecorder();
  // Limpieza de stream y nodos (pero NO destruimos AudioContext)
  try{
    VX_stopMeterLoop();
    VX_disconnectNodes();
    if(VX_stream){
      VX_stream.getTracks().forEach(t=>t.stop());
    }
  }catch(e){}
  VX_stream = null;
  VX_rec = null;

  return blob;
}

// ===== VAD Auto-stop =====
async function VX_recordWithAutoStop({ onLog=()=>{}, onState=()=>{} } = {}){
  onState("listening");
  onLog("SYS: Escuchando… (auto-stop por silencio)");

  await VX_startRecordingInternal();

  // Calibración ruido base
  const t0 = VX_now();
  let noise = 0, n=0;

  while(VX_now()-t0 < VX_CFG.calibrateMs){
    await VX_sleep(50);
    noise += VX_getRms(); n++;
  }
  noise = n ? noise/n : 0.008;

  const startThr = noise + VX_CFG.startMargin;
  const silenceThr = noise + VX_CFG.silenceMargin;

  onLog(`SYS: Calibrado. ruido=${noise.toFixed(3)} start=${startThr.toFixed(3)} silence=${silenceThr.toFixed(3)}`);

  let hadSpeech = false;
  let speechMs = 0;
  let silenceStart = null;
  const hardStart = VX_now();

  while(true){
    if(VX_stopRequested) break;

    if(VX_now()-hardStart > VX_CFG.hardMaxMs){
      onLog("SYS: Auto-stop por límite de tiempo.");
      break;
    }

    const rms = VX_getRms();

    if(rms > startThr){
      hadSpeech = true;
      speechMs += 50;
      silenceStart = null;
    }else{
      if(hadSpeech){
        if(silenceStart == null) silenceStart = VX_now();
        const silMs = VX_now() - silenceStart;
        if(speechMs >= VX_CFG.minSpeechMs && silMs >= VX_CFG.silenceHoldMs){
          onLog("SYS: Auto-stop por silencio.");
          break;
        }
      }
    }

    await VX_sleep(50);
  }

  const blob = await VX_stopRecordingInternal();

  // Validación: si no hubo voz real, regresamos null (sin romper siguiente intento)
  if(!blob || !hadSpeech || speechMs < VX_CFG.minSpeechMs){
    onState("idle");
    onLog("SYS: No detecté voz clara. Habla 1–2s y luego silencio. Intenta otra vez.");
    return null;
  }

  return blob;
}

// ===== Prompt =====
function VX_buildPrompt(mode, userText){
  const base = `Eres un coach de inglés. Responde en español, corrige la frase del usuario y da 2 ejemplos en inglés.`;
  const styles = {
    coach: "Sé motivador, directo y práctico.",
    friendly: "Sé amable y breve.",
    strict: "Sé exigente y específico."
  };
  return `${base}\nEstilo: ${styles[mode] || styles.coach}\nUsuario dijo: "${userText}"`;
}

// ===== Turno completo =====
async function VX_runTurn({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  if(VX_state !== "idle") return;

  try{
    const blob = await VX_recordWithAutoStop({ onLog, onState });
    if(!blob){
      // IMPORTANTE: dejar listo para el siguiente intento
      VX_state = "idle";
      VX_stopRequested = false;
      return;
    }

    onState("thinking");
    onLog("SYS: STT…");
    const text = await window.VX_transcribeAudio(blob);

    const clean = (text || "").trim();
    if(!clean){
      onLog("SYS: No transcribí algo usable. Intenta de nuevo.");
      VX_state = "idle";
      onState("idle");
      return;
    }

    onLog("YOU: " + clean);

    onLog("SYS: CHAT…");
    const reply = await window.VX_chatReply(VX_buildPrompt(mode, clean));
    onLog("BOT: " + reply);

    onLog("SYS: TTS…");
    const audio = await window.VX_ttsAudio(reply);
    await window.VX_playAudio(audio);

    onState("idle");
  } catch(e){
    console.error(e);
    onState("error");
    onLog("SYS: ERROR: " + (e?.message || String(e)));
  } finally{
    // 🔥 Clave: SIEMPRE dejamos todo listo para el siguiente turno
    VX_cleanupAll();
    VX_state = "idle";
    VX_stopRequested = false;
  }
}

// ===== API para UI =====
async function VX_startAutoTalk({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  await VX_resumeAudioCtx();     // garantiza contexto activo en cada click
  await VX_runTurn({ mode, onLog, onState });
}

function VX_forceStop(){
  if(VX_state === "recording"){
    VX_stopRequested = true;
  }
}

// Export
window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;
window.VX_startAutoTalk = VX_startAutoTalk;
window.VX_forceStop = VX_forceStop;

console.log("✅ voiceRecorder loaded (AutoStop PRO v2)", {
  VX_startAutoTalk: typeof window.VX_startAutoTalk,
  VX_forceStop: typeof window.VX_forceStop
});








