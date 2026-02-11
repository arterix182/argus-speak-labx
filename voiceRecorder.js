// voiceRecorder.js (COMPLETO - AutoStop PRO + Click-to-talk + Force stop)
// Requiere voicePipeline.js antes (VX_transcribeAudio, VX_chatReply, VX_ttsAudio, VX_playAudio)

let VX_deviceId = localStorage.getItem("VX_MIC") || "";

let VX_stream = null;
let VX_rec = null;
let VX_chunks = [];

let VX_audioCtx = null;
let VX_analyser = null;
let VX_meterRAF = null;

let VX_state = "idle"; // idle | recording | processing
let VX_stopRequested = false;

// ====== Ajustes VAD (silencio) ======
const VX_CFG = {
  chunkMs: 200,
  hardMaxMs: 12000,          // máximo grabación
  calibrateMs: 500,          // tiempo para medir ruido base
  startMargin: 0.020,        // qué tan arriba del ruido se considera voz
  silenceMargin: 0.012,      // qué tan cerca del ruido se considera silencio
  minSpeechMs: 250,          // debe haber voz mínimo para “validar” que hablaste
  silenceHoldMs: 700         // silencio continuo para auto-stop
};

function VX_err(e){ console.error(e); }
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

// ===== Meter + RMS =====
function VX_ensureAudioCtx(){
  VX_audioCtx = VX_audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  return VX_audioCtx;
}

function VX_startAnalyser(stream){
  const ctx = VX_ensureAudioCtx();
  const src = ctx.createMediaStreamSource(stream);
  VX_analyser = ctx.createAnalyser();
  VX_analyser.fftSize = 512;
  src.connect(VX_analyser);
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
  const tick=()=>{
    const rms = VX_getRms();
    if(typeof window.VX_onMeter==="function") window.VX_onMeter(Math.min(1, rms*3.2));
    VX_meterRAF = requestAnimationFrame(tick);
  };
  VX_meterRAF = requestAnimationFrame(tick);
}

function VX_stopMeterLoop(){
  if(VX_meterRAF) cancelAnimationFrame(VX_meterRAF);
  VX_meterRAF=null;
}

// ===== Clean up =====
function VX_cleanupStream(){
  try{
    VX_stopMeterLoop();
    VX_analyser = null;
    if(VX_stream){
      VX_stream.getTracks().forEach(t=>t.stop());
    }
  }catch(e){}
  VX_stream=null;
}

async function VX_safeStopRecorder(){
  // Detener recorder y esperar onstop sin quedarse colgado
  if(!VX_rec) return null;

  const rec = VX_rec;
  VX_rec = null;

  if(rec.state !== "recording"){
    return null;
  }

  const blob = await new Promise((resolve, reject)=>{
    let done=false;

    const kill = setTimeout(()=>{
      if(done) return;
      done=true;
      try{ resolve(null); }catch(e){}
    }, 1500); // si algo falla, no nos quedamos atorados

    rec.onstop = ()=>{
      if(done) return;
      done=true;
      clearTimeout(kill);
      try{
        const b = new Blob(VX_chunks, { type:"audio/webm" });
        resolve(b);
      }catch(e){ reject(e); }
    };

    try{ rec.stop(); }
    catch(e){ clearTimeout(kill); reject(e); }
  });

  return blob;
}

// ===== Grabación =====
async function VX_startRecordingInternal(){
  if(VX_state !== "idle") return;
  VX_state = "recording";
  VX_stopRequested = false;
  VX_chunks = [];

  // stream nuevo cada turno (clave para que no muera después del 1ro)
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
  VX_cleanupStream();

  return blob;
}

// ===== VAD Auto-stop =====
async function VX_recordWithAutoStop({ onLog=()=>{}, onState=()=>{} } = {}){
  // Inicia
  onState("listening");
  onLog("SYS: Escuchando… (auto-stop por silencio)");
  await VX_startRecordingInternal();

  // Calibración de ruido base
  const t0 = VX_now();
  let noise = 0, n=0;
  while(VX_now()-t0 < VX_CFG.calibrateMs){
    await new Promise(r=>setTimeout(r, 50));
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

    // hard limit
    if(VX_now()-hardStart > VX_CFG.hardMaxMs){
      onLog("SYS: Auto-stop por límite de tiempo.");
      break;
    }

    const rms = VX_getRms();

    // Detectar voz
    if(rms > startThr){
      hadSpeech = true;
      speechMs += 50;
      silenceStart = null;
    }else{
      // Silencio
      if(hadSpeech){
        if(silenceStart == null) silenceStart = VX_now();
        const silMs = VX_now() - silenceStart;

        // Solo auto-stop si realmente hubo voz suficiente
        if(speechMs >= VX_CFG.minSpeechMs && silMs >= VX_CFG.silenceHoldMs){
          onLog("SYS: Auto-stop por silencio.");
          break;
        }
      }
    }

    await new Promise(r=>setTimeout(r, 50));
  }

  const blob = await VX_stopRecordingInternal();

  // Si no habló nada, salimos suave
  if(!blob || !hadSpeech || speechMs < VX_CFG.minSpeechMs){
    onState("idle");
    onLog("SYS: Habla 1–2 segundos y luego guarda silencio. Intenta de nuevo.");
    return null;
  }

  return blob;
}

// ===== Turno completo (STT → CHAT → TTS) =====
function VX_buildPrompt(mode, userText){
  const base = `Eres un coach de inglés. Responde en español, corrige la frase del usuario y da 2 ejemplos en inglés.`;
  const styles = {
    coach: "Sé motivador, directo y práctico.",
    friendly: "Sé amable y breve.",
    strict: "Sé exigente y específico."
  };
  return `${base}\nEstilo: ${styles[mode] || styles.coach}\nUsuario dijo: "${userText}"`;
}

async function VX_runTurn({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  if(VX_state !== "idle") return;

  try{
    const blob = await VX_recordWithAutoStop({ onLog, onState });
    if(!blob) return;

    onState("thinking");
    onLog("SYS: STT…");
    const text = await window.VX_transcribeAudio(blob);
    const clean = (text || "").trim();
    if(!clean){
      onState("idle");
      onLog("SYS: No detecté voz clara. Intenta de nuevo.");
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
  }catch(e){
    VX_err(e);
    VX_state = "idle";
    onState("error");
    onLog("SYS: ERROR: " + (e?.message || String(e)));
    throw e;
  }finally{
    // Asegurar que siempre regresamos a idle si algo explotó
    if(VX_state !== "recording") {
      VX_stopRequested = false;
      try{ VX_cleanupStream(); }catch(e){}
      if(VX_state !== "processing") VX_state = "idle";
    }
  }
}

// ===== Control desde UI =====
async function VX_startAutoTalk({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  // Click para empezar. Se detiene solo por silencio.
  await VX_runTurn({ mode, onLog, onState });
}

function VX_forceStop(){
  // Click mientras graba para forzar stop
  if(VX_state === "recording"){
    VX_stopRequested = true;
  }
}

// Export global
window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;

window.VX_startAutoTalk = VX_startAutoTalk;
window.VX_forceStop = VX_forceStop;

console.log("✅ voiceRecorder loaded (AutoStop PRO)", {
  VX_startAutoTalk: typeof window.VX_startAutoTalk,
  VX_forceStop: typeof window.VX_forceStop
});







