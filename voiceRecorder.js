// voiceRecorder.js (COMPLETO - Call Mode PRO v4 estable)
// Requiere voicePipeline.js con:
//   window.VX_transcribeAudio(blob) -> texto
//   window.VX_chatReply(texto) -> reply
//   window.VX_ttsAudio(reply) -> ArrayBuffer
//   window.VX_playAudio(buf) -> Promise (espera onended)
// UI hook opcional:
//   window.VX_onMeter(level01)

let VX_deviceId = localStorage.getItem("VX_MIC") || "";

let VX_audioCtx = null;
let VX_stream = null;
let VX_srcNode = null;
let VX_analyser = null;
let VX_meterRAF = null;

let VX_rec = null;
let VX_chunks = [];

let VX_callActive = false;
let VX_busy = false;
let VX_stopRequested = false;

let VX_keepOsc = null;
let VX_keepGain = null;

const VX_CFG = {
  chunkMs: 200,
  hardMaxMs: 12000,
  calibrateMs: 500,
  startMargin: 0.020,
  minSpeechMs: 250,
  silenceHoldMs: 700,
};

const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));
const now = ()=>performance.now();

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
  const ctx = VX_ensureAudioCtx();
  if(VX_keepOsc) return;

  VX_keepGain = ctx.createGain();
  VX_keepGain.gain.value = 0.00001;
  VX_keepGain.connect(ctx.destination);

  VX_keepOsc = ctx.createOscillator();
  VX_keepOsc.frequency.value = 20;
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

async function VX_getStream(){
  const constraints = { audio: VX_deviceId ? { deviceId: { exact: VX_deviceId } } : true };
  return await navigator.mediaDevices.getUserMedia(constraints);
}

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
    if(typeof window.VX_onMeter==="function"){
      window.VX_onMeter(Math.min(1, rms*3.2));
    }
    VX_meterRAF = requestAnimationFrame(tick);
  };
  VX_meterRAF = requestAnimationFrame(tick);
}
function VX_stopMeterLoop(){
  if(VX_meterRAF) cancelAnimationFrame(VX_meterRAF);
  VX_meterRAF = null;
  if(typeof window.VX_onMeter==="function") window.VX_onMeter(0);
}

// ===== MIC LIST =====
async function VX_listMics(){
  // Trigger permission so labels appear
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

// ===== CALL STREAM LIFECYCLE =====
async function VX_callEnsureStream(){
  if(VX_stream) return VX_stream;
  await VX_resumeAudioCtx();
  VX_startKeepAlive();

  VX_stream = await VX_getStream();
  VX_startAnalyser(VX_stream);
  VX_startMeterLoop();
  return VX_stream;
}

function VX_callReleaseStream(){
  try{
    VX_stopMeterLoop();
    VX_disconnectNodes();
    if(VX_stream) VX_stream.getTracks().forEach(t=>t.stop());
  }catch(e){}
  VX_stream = null;
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

// ===== RECORD ONE TURN (auto-stop by silence) =====
async function VX_recordOneTurn({onLog=()=>{}, onState=()=>{}}){
  await VX_callEnsureStream();

  VX_chunks = [];
  VX_stopRequested = false;

  onState("listening");
  onLog("SYS: Escuchando… (silencio = stop)");

  VX_rec = new MediaRecorder(VX_stream, { mimeType:"audio/webm" });
  VX_rec.ondataavailable = (ev)=>{ if(ev.data && ev.data.size) VX_chunks.push(ev.data); };
  VX_rec.start(VX_CFG.chunkMs);

  // Calibrate noise
  const t0 = now();
  let noise=0,n=0;
  while(now()-t0 < VX_CFG.calibrateMs){
    await sleep(50);
    noise += VX_getRms(); n++;
  }
  noise = n? noise/n : 0.008;
  const startThr = noise + VX_CFG.startMargin;

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
      if(silenceStart==null) silenceStart = now();
      const silMs = now()-silenceStart;
      if(speechMs >= VX_CFG.minSpeechMs && silMs >= VX_CFG.silenceHoldMs){
        onLog("SYS: Auto-stop por silencio.");
        break;
      }
    }
    await sleep(50);
  }

  const blob = await new Promise((resolve)=>{
    let done=false;
    const kill = setTimeout(()=>{ if(!done){ done=true; resolve(null);} }, 1500);
    VX_rec.onstop = ()=>{
      if(done) return;
      done=true; clearTimeout(kill);
      try{ resolve(new Blob(VX_chunks, { type:"audio/webm" })); }catch(e){ resolve(null); }
    };
    try{ VX_rec.stop(); }catch(e){ clearTimeout(kill); resolve(null); }
  });

  VX_rec = null;
  VX_chunks = [];

  if(!blob || !hadSpeech || speechMs < VX_CFG.minSpeechMs){
    onLog("SYS: No detecté voz clara. Intenta de nuevo.");
    onState("idle");
    return null;
  }

  return blob;
}

// ===== CALL LOOP =====
async function VX_callLoop({mode="coach", onLog=()=>{}, onState=()=>{}}){
  if(VX_busy) return;
  VX_busy = true;

  try{
    while(VX_callActive){
      const blob = await VX_recordOneTurn({onLog,onState});
      if(!VX_callActive) break;
      if(!blob){
        await sleep(200);
        continue;
      }

      onState("thinking");
      onLog("SYS: STT…");
      const text = await window.VX_transcribeAudio(blob);
      const clean = (text||"").trim();
      if(!clean){
        onLog("SYS: Transcripción vacía.");
        onState("idle");
        await sleep(200);
        continue;
      }
      onLog("YOU: " + clean);

      onLog("SYS: CHAT…");
      const reply = await window.VX_chatReply(VX_buildPrompt(mode, clean));
      onLog("BOT: " + reply);

      // 🔥 Aquí el estado que hace que el avatar pase a "speaking"
      onState("speaking");
      onLog("SYS: TTS…");
      const audio = await window.VX_ttsAudio(reply);
      await window.VX_playAudio(audio);

      if(VX_callActive) onState("listening");
      await sleep(150);
    }
  } catch(e){
    console.error(e);
    onState("error");
    onLog("SYS: ERROR: " + (e?.message || String(e)));
  } finally{
    VX_busy = false;
  }
}

// ===== PUBLIC API =====
async function VX_callStart({mode="coach", onLog=()=>{}, onState=()=>{}} = {}){
  VX_callActive = true;
  await VX_callEnsureStream();
  await VX_callLoop({mode,onLog,onState});
}
function VX_callStop(){
  VX_callActive = false;
  VX_stopRequested = true;
}
function VX_callHardStop(){
  VX_callActive = false;
  VX_stopRequested = true;
  VX_callReleaseStream();
  VX_stopKeepAlive();
}
function VX_forceStop(){
  VX_stopRequested = true;
}

// Expose
window.VX_listMics = VX_listMics;
window.VX_setMic = VX_setMic;

window.VX_callStart = VX_callStart;
window.VX_callStop = VX_callStop;
window.VX_callHardStop = VX_callHardStop;
window.VX_forceStop = VX_forceStop;

console.log("✅ voiceRecorder loaded (v4)", {
  VX_callStart: typeof window.VX_callStart,
  VX_callHardStop: typeof window.VX_callHardStop,
  VX_forceStop: typeof window.VX_forceStop
});






