// voiceRecorder.js (COMPLETO - AutoStop PRO v3 + Call KeepAlive)
// Fix: en llamada el 2do turno se moría por AudioContext suspendido.
// Requiere voicePipeline.js: VX_transcribeAudio, VX_chatReply, VX_ttsAudio, VX_playAudio

let VX_deviceId = localStorage.getItem("VX_MIC") || "";

let VX_stream = null;
let VX_rec = null;
let VX_chunks = [];

let VX_audioCtx = null;
let VX_srcNode = null;
let VX_analyser = null;
let VX_meterRAF = null;

let VX_keepOsc = null;
let VX_keepGain = null;
let VX_callKeepAlive = false;

let VX_state = "idle"; // idle | recording | processing
let VX_stopRequested = false;

// ===== Ajustes VAD =====
const VX_CFG = {
  chunkMs: 200,
  hardMaxMs: 12000,
  calibrateMs: 500,
  startMargin: 0.020,
  silenceMargin: 0.012,
  minSpeechMs: 250,
  silenceHoldMs: 700
};

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const now = ()=>performance.now();

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

// ===== AudioContext keep-alive =====
function VX_ensureAudioCtx(){
  if(!VX_audioCtx) VX_audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return VX_audioCtx;
}

async function VX_resumeAudioCtx(){
  const ctx = VX_ensureAudioCtx();
  if(ctx.state === "suspended"){
    try{ await ctx.resume(); }catch(e){}
  }
}

function VX_startKeepAlive(){
  // Oscilador silencioso para que el AudioContext NO se suspenda en call mode
  const ctx = VX_ensureAudioCtx();
  if(VX_keepOsc) return;

  VX_keepGain = ctx.createGain();
  VX_keepGain.gain.value = 0.00001; // prácticamente silencio
  VX_keepGain.connect(ctx.destination);

  VX_keepOsc = ctx.createOscillator();
  VX_keepOsc.frequency.value = 20; // inaudible
  VX_keepOsc.connect(VX_keepGain);

  try{ VX_keepOsc.start(); }catch(e){}
}

function VX_stopKeepAlive(){
  try{ VX_keepOsc?.stop(); }catch(e){}
  try{ VX_keepOsc?.disconnect(); }catch(e){}
  try{ VX_keepGain?.disconnect(); }catch(e){}
  VX_keepOsc = null;
  VX_keepGain = null;
}

function VX_setCallKeepAlive(on){
  VX_callKeepAlive = !!on;
  if(VX_callKeepAlive){
    VX_resumeAudioCtx().then(()=>VX_startKeepAlive());
  }else{
    VX_stopKeepAlive();
  }
}

// ===== Nodes =====
function VX_disconnectNodes(){
  try{ VX_srcNode?.disconnect(); }catch(e){}
  try{ VX_analyser?.disconnect(); }catch(e){}
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
  if(typeof window.VX_onMeter==="function") window.VX_onMeter(0);
}

// ===== Cleanup =====
function VX_cleanupTurn(){
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

// ===== Recorder stop safe =====
async function VX_safeStopRecorder(){
  if(!VX_rec) return null;
  const rec = VX_rec;
  if(rec.state !== "recording") return null;

  const blob = await new Promise((resolve)=>{
    let done=false;
    const kill = setTimeout(()=>{ if(!done){ done=true; resolve(null);} }, 1500);

    rec.onstop = ()=>{
      if(done) return;
      done=true;
      clearTimeout(kill);
      try{ resolve(new Blob(VX_chunks, { type:"audio/webm" })); }
      catch(e){ resolve(null); }
    };

    try{ rec.stop(); }catch(e){ clearTimeout(kill); resolve(null); }
  });

  return blob;
}

// ===== Start/Stop internal =====
async function VX_startRecordingInternal(){
  if(VX_state !== "idle") return;
  VX_state = "recording";
  VX_stopRequested = false;
  VX_chunks = [];

  await VX_resumeAudioCtx();
  if(VX_callKeepAlive) VX_startKeepAlive();

  VX_stream = await VX_getStream();
  VX_startAnalyser(VX_stream);
  VX_startMeterLoop();

  VX_rec = new MediaRecorder(VX_stream, { mimeType:"audio/webm" });
  VX_rec.ondataavailable = (ev)=>{ if(ev.data && ev.data.size) VX_chunks.push(ev.data); };
  VX_rec.start(VX_CFG.chunkMs);
}

async function VX_stopRecordingInternal(){
  if(VX_state !== "recording") return null;
  VX_state = "processing";

  const blob = await VX_safeStopRecorder();
  try{
    VX_stopMeterLoop();
    VX_disconnectNodes();
    if(VX_stream) VX_stream.getTracks().forEach(t=>t.stop());
  }catch(e){}
  VX_stream = null;
  VX_rec = null;

  return blob;
}

// ===== AutoStop =====
async function VX_recordWithAutoStop({ onLog=()=>{}, onState=()=>{} } = {}){
  onState("listening");
  onLog("SYS: Escuchando… (auto-stop por silencio)");
  await VX_startRecordingInternal();

  const t0 = now();
  let noise=0, n=0;
  while(now()-t0 < VX_CFG.calibrateMs){
    await sleep(50);
    noise += VX_getRms(); n++;
  }
  noise = n ? noise/n : 0.008;

  const startThr = noise + VX_CFG.startMargin;

  onLog(`SYS: Calibrado. ruido=${noise.toFixed(3)} start=${startThr.toFixed(3)}`);

  let hadSpeech=false;
  let speechMs=0;
  let silenceStart=null;
  const hardStart = now();

  while(true){
    if(VX_stopRequested) break;
    if(now()-hardStart > VX_CFG.hardMaxMs){ onLog("SYS: Auto-stop por límite."); break; }

    const rms = VX_getRms();

    if(rms > startThr){
      hadSpeech=true;
      speechMs += 50;
      silenceStart=null;
    }else if(hadSpeech){
      if(silenceStart == null) silenceStart = now();
      const silMs = now()-silenceStart;
      if(speechMs >= VX_CFG.minSpeechMs && silMs >= VX_CFG.silenceHoldMs){
        onLog("SYS: Auto-stop por silencio.");
        break;
      }
    }

    await sleep(50);
  }

  const blob = await VX_stopRecordingInternal();

  if(!blob || !hadSpeech || speechMs < VX_CFG.minSpeechMs){
    onState("idle");
    onLog("SYS: No detecté voz clara. Intenta de nuevo.");
    return null;
  }

  return blob;
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

// ===== Turno =====
async function VX_runTurn({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  if(VX_state !== "idle") return;

  try{
    const blob = await VX_recordWithAutoStop({ onLog, onState });
    if(!blob){ VX_state="idle"; return; }

    onState("thinking");
    onLog("SYS: STT…");
    const text = await window.VX_transcribeAudio(blob);
    const clean = (text||"").trim();
    if(!clean){
      onLog("SYS: No transcribí algo usable.");
      onState("idle");
      return;
    }
    onLog("YOU: " + clean);

    onLog("SYS: CHAT…");
    const reply = await window.VX_chatReply(VX_buildPrompt(mode, clean));
    onLog("BOT: " + reply);

    onLog("SYS: TTS…");
    const audio = await window.VX_ttsAudio(reply);
    await window.VX_playAudio(audio); // ahora espera a que termine

    onState("idle");
  } catch(e){
    console.error(e);
    onState("error");
    onLog("SYS: ERROR: " + (e?.message || String(e)));
  } finally{
    VX_cleanupTurn();
    VX_state = "idle";
    VX_stopRequested = false;
  }
}

// ===== API =====
async function VX_startAutoTalk({ mode="coach", onLog=()=>{}, onState=()=>{} } = {}){
  await VX_resumeAudioCtx();
  if(VX_callKeepAlive) VX_startKeepAlive();
  await VX_runTurn({ mode, onLog, onState });
}

function VX_forceStop(){
  if(VX_state === "recording") VX_stopRequested = true;
}

window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;
window.VX_startAutoTalk = VX_startAutoTalk;
window.VX_forceStop = VX_forceStop;
window.VX_setCallKeepAlive = VX_setCallKeepAlive;

console.log("✅ voiceRecorder loaded (v3)", {
  VX_startAutoTalk: typeof window.VX_startAutoTalk,
  VX_forceStop: typeof window.VX_forceStop,
  VX_setCallKeepAlive: typeof window.VX_setCallKeepAlive
});








