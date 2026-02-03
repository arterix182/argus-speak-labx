/* ARGUS SPEAK LAB-X — Article + AI Prototype
   Client calls /api/ai (Netlify function) to keep OpenAI key secret.
*/
const $ = (q) => document.querySelector(q);

// API base autodetect: "/api" (with redirect) or "/.netlify/functions" (direct)
let API_BASE = "/api";
function apiEndpoint(name){
  name = String(name||"").replace(/^\/+/, "");
  return `${API_BASE}/${name}`;
}


/* ---------- ARGUS_DEBUG: capture errors so the app never "dies" silently ---------- */
const ARGUS_DEBUG = (() => {
  const state = { last: "", count: 0 };
  function ensure(){
    let bar = document.getElementById("debugBar");
    if(bar) return bar;
    bar = document.createElement("div");
    bar.id = "debugBar";
    bar.hidden = true;
    bar.innerHTML = `<div class="debugBar__inner">
      <div class="debugBar__title">⚠️ Error detectado</div>
      <div class="debugBar__msg" id="debugBarMsg"></div>
      <div class="debugBar__row">
        <button class="btn btn--ghost btn--mini" id="debugCopy">Copiar</button>
        <button class="btn btn--ghost btn--mini" id="debugHide">Ocultar</button>
      </div>
    </div>`;
    document.body.appendChild(bar);

    const hide = () => { bar.hidden = true; };
    bar.querySelector("#debugHide")?.addEventListener("click", hide);
    bar.addEventListener("click", (e) => {
      if((e.target?.id||"") === "debugCopy" || (e.target?.id||"") === "debugHide") return;
      hide();
    });
    bar.querySelector("#debugCopy")?.addEventListener("click", async () => {
      try{ await navigator.clipboard.writeText(state.last || ""); }catch{}
    });
    return bar;
  }
  function show(msg){
    state.last = String(msg || "");
    state.count++;
    const bar = ensure();
    const el = bar.querySelector("#debugBarMsg");
    if(el) el.textContent = state.last;
    bar.hidden = false;
  }
  function fmt(e){
    if(!e) return "Unknown error";
    if(typeof e === "string") return e;
    if(e?.message) return e.message;
    try{ return JSON.stringify(e); }catch{ return String(e); }
  }
  window.addEventListener("error", (ev) => {
    const msg = ev?.error?.stack || `${ev?.message || "Error"} @ ${ev?.filename||""}:${ev?.lineno||""}`;
    show(msg);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const msg = ev?.reason?.stack || fmt(ev?.reason) || "Unhandled promise rejection";
    show(msg);
  });
  return { show };
})();

/* ---------- Auth + Subscription (Supabase + Stripe) ---------- */
const planPill = $("#planPill");
const btnAccount = $("#btnAccount");
const accountModal = $("#accountModal");
const accountBackdrop = $("#accountBackdrop");
const btnAccountClose = $("#btnAccountClose");
const accountEmailEl = $("#accountEmail");
const authEmailEl = $("#authEmail");
const btnSendLink = $("#btnSendLink");
const btnLogout = $("#btnLogout");
const btnSubscribe = $("#btnSubscribe");
const btnManage = $("#btnManage");
const billingMsg = $("#billingMsg");
const authMsg = $("#authMsg");

let supabaseClient = null;
let authSession = null;
let meState = { pro:false, status:"free", email:"Invitado" };

function setPlanPillUI(){
  if(!planPill) return;
  if(meState.pro){
    planPill.textContent = "PRO";
    planPill.dataset.plan = "pro";
  }else{
    planPill.textContent = "FREE";
    delete planPill.dataset.plan;
  }
}

function showAuthMsg(text){
  if(authMsg) authMsg.textContent = text || "";
}
function showBillingMsg(text){
  if(billingMsg) billingMsg.textContent = text || "";
}

function openAccountModal(){
  if(!accountModal) return;
  accountModal.hidden = false;
  document.body.style.overflow = "hidden";
  showAuthMsg("");
  showBillingMsg("");
  // refresh status when opening
  refreshMe().catch(()=>{});
}
function closeAccountModal(){
  if(!accountModal) return;
  accountModal.hidden = true;
  document.body.style.overflow = "";
}

// Reset PWA cache (useful when a Service Worker got stuck)
const btnResetApp = $("#btnResetApp");
async function hardResetApp(){
  try{
    try{ stopSpeech(); }catch{}
    try{ stopListen(); }catch{}
    if("serviceWorker" in navigator){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if("caches" in window){
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  }catch(e){
    try{ ARGUS_DEBUG.show(e?.stack || e?.message || String(e)); }catch{}
  }finally{
    location.reload();
  }
}
if(btnResetApp){
  btnResetApp.addEventListener("click", () => {
    const ok = confirm("Esto borrará el caché de la app (PWA) y recargará. ¿Continuar?");
    if(ok) hardResetApp();
  });
}

if(btnAccount){
  btnAccount.addEventListener("click", openAccountModal);
}
if(btnAccountClose){
  btnAccountClose.addEventListener("click", closeAccountModal);
}
if(accountBackdrop){
  accountBackdrop.addEventListener("click", closeAccountModal);
}

function authHeaders(){
  if(!authSession?.access_token) return {};
  return { "Authorization": "Bearer " + authSession.access_token };
}

async function fetchConfig(){
  const candidates = [
    { base:"/api", url:"/api/config" },
    { base:"/.netlify/functions", url:"/.netlify/functions/config" }
  ];
  for(const c of candidates){
    try{
      const res = await fetch(c.url, { cache:"no-store" });
      // If it's not 404, we consider this base as "reachable" even if it returns a config error.
      if(res.status !== 404){
        API_BASE = c.base;
      }
      if(!res.ok){
        const t = await res.text().catch(()=> "");
        // Show a helpful message once; don't crash the app.
        if(res.status === 404){
          // try next candidate
        } else {
          ARGUS_DEBUG.show(`Config error (${res.status}): ${t || "Sin detalles"}`);
        }
        continue;
      }
      const data = await res.json().catch(()=> ({}));
      return data;
    }catch(err){
      // try next candidate
    }
  }
  ARGUS_DEBUG.show("No se pudo cargar /api/config. Revisa que Netlify Functions estén desplegadas y que exista el redirect /api/*.");
  return { supabaseUrl:"", supabaseAnonKey:"" };
}


async function initSupabaseAuth(){
  if(!window.supabase){
    showAuthMsg("⚠️ No se pudo cargar Supabase (revisa internet o bloqueador).");
    try{ btnSendLink && (btnSendLink.disabled = true); }catch(_){ }
    try{ btnSubscribe && (btnSubscribe.disabled = true); }catch(_){ }
    return;
  }
  const cfg = await fetchConfig();
  if(!cfg?.supabaseUrl || !cfg?.supabaseAnonKey){
    showAuthMsg("⚠️ Falta configurar SUPABASE_URL / SUPABASE_ANON_KEY en Netlify.");
    return;
  }
  const projectRef = new URL(cfg.supabaseUrl).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

supabaseClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, storageKey }
});


  const { data } = await supabaseClient.auth.getSession();
  authSession = data?.session || null;

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    authSession = session || null;
    await ensureProfile().catch(()=>{});
    await refreshMe().catch(()=>{});
    renderAccountUI();
  });

  await ensureProfile().catch(()=>{});
  await refreshMe().catch(()=>{});
  renderAccountUI();
}

async function ensureProfile(){
  if(!supabaseClient || !authSession?.user?.id) return;
  const u = authSession.user;
  // Try read; if missing, insert
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id")
    .eq("id", u.id)
    .maybeSingle();
  if(error) return;
  if(!data){
    await supabaseClient
      .from("profiles")
      .insert({ id: u.id, email: u.email })
      .select()
      .maybeSingle();
  }
}

async function refreshMe(){
  // If not logged in, update UI and stop
  if(!authSession?.access_token){
    meState = { pro:false, status:"free", email:"Invitado" };
    setPlanPillUI();
    renderAccountUI();
    return meState;
  }
  const res = await fetch(apiEndpoint("me"), { headers: { ...authHeaders() } });
  if(!res.ok){
    // If backend not configured, still show logged-in state
    const email = authSession?.user?.email || "Cuenta";
    meState = { pro:false, status:"unknown", email };
    setPlanPillUI();
    renderAccountUI();
    return meState;
  }
  const data = await res.json();
  meState = {
    pro: !!data?.pro,
    status: data?.subscription?.status || "free",
    email: data?.user?.email || authSession?.user?.email || "Cuenta"
  };
  setPlanPillUI();
  renderAccountUI();
  return meState;
}

function renderAccountUI(){
  const email = meState?.email || "Invitado";
  if(accountEmailEl) accountEmailEl.textContent = email;
  const loggedIn = !!authSession?.access_token;

  if(btnLogout) btnLogout.hidden = !loggedIn;
  if(btnSendLink) btnSendLink.disabled = !supabaseClient;

  // Subscription controls
  if(btnManage) btnManage.hidden = !meState.pro;
  if(btnSubscribe) btnSubscribe.hidden = meState.pro;

  setPlanPillUI();
}

if(btnSendLink){
  btnSendLink.addEventListener("click", async () => {
    const email = (authEmailEl?.value || "").trim();
    if(!supabaseClient){
      showAuthMsg("⚠️ Supabase no está listo (¿sin internet o falta config?).");
      return;
    }
    if(!email || !email.includes("@")){
      showAuthMsg("Escribe un email válido.");
      return;
    }
    showAuthMsg("Enviando link…");
    try{
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await supabaseClient.auth.signInWithOtp({ email, options:{ emailRedirectTo: redirectTo } });
      if(error) throw error;
      showAuthMsg("✅ Listo. Revisa tu correo y abre el link para entrar.");
    }catch(err){
      showAuthMsg("❌ " + (err?.message || "No se pudo enviar el link."));
    }
  });
}

if(btnLogout){
  btnLogout.addEventListener("click", async () => {
    try{
      await supabaseClient?.auth?.signOut();
    }catch(_){}
    closeAccountModal();
  });
}

async function startCheckout(){
  if(!authSession?.access_token){
    openAccountModal();
    showAuthMsg("Entra con tu email para poder suscribirte.");
    return;
  }
  showBillingMsg("Abriendo checkout…");
  try{
    const res = await fetch(apiEndpoint("create-checkout"), {
      method:"POST",
      headers: { "Content-Type":"application/json", ...authHeaders() },
      body: JSON.stringify({})
    });
    if(!res.ok){
      const t = await res.text().catch(()=> "");
      throw new Error(t || "checkout error");
    }
    const data = await res.json();
    if(data?.url) window.location.href = data.url;
    else throw new Error("No checkout url");
  }catch(err){
    showBillingMsg("❌ " + (err?.message || "No se pudo abrir el checkout."));
  }
}

async function openPortal(){
  if(!authSession?.access_token){
    openAccountModal();
    return;
  }
  showBillingMsg("Abriendo portal…");
  try{
    const res = await fetch(apiEndpoint("create-portal"), {
      method:"POST",
      headers: { "Content-Type":"application/json", ...authHeaders() },
      body: JSON.stringify({})
    });
    if(!res.ok){
      const t = await res.text().catch(()=> "");
      throw new Error(t || "portal error");
    }
    const data = await res.json();
    if(data?.url) window.location.href = data.url;
    else throw new Error("No portal url");
  }catch(err){
    showBillingMsg("❌ " + (err?.message || "No se pudo abrir el portal."));
  }
}

if(btnSubscribe){
  btnSubscribe.addEventListener("click", startCheckout);
}
if(btnManage){
  btnManage.addEventListener("click", openPortal);
}

// Init auth early
initSupabaseAuth().catch(()=>{});
setPlanPillUI();

// Post-checkout UX
try{
  const url = new URL(window.location.href);
  const hadSuccess = (url.searchParams.get("success")==="1");
  const hadCanceled = (url.searchParams.get("canceled")==="1");

  if(hadSuccess || hadCanceled){
    // Clean the URL so the message doesn't loop forever on refresh.
    url.searchParams.delete("success");
    url.searchParams.delete("canceled");
    history.replaceState({}, document.title, url.pathname + (url.search ? url.search : ""));
  }

  if(hadCanceled){
    openAccountModal();
    showBillingMsg("⚠️ Pago cancelado. Puedes intentarlo de nuevo cuando quieras.");
  }

  if(hadSuccess){
    openAccountModal();
    showBillingMsg("✅ Pago recibido. Confirmando acceso PRO…");

    // Poll for PRO status (webhook can take a few seconds).
    let tries = 0;
    const maxTries = 20; // ~40s
    const timer = setInterval(async () => {
      tries++;
      try{ await refreshMe(); }catch(_){}
      if(meState?.pro){
        showBillingMsg("✅ Listo: acceso PRO activado.");
        clearInterval(timer);
      } else if(tries >= maxTries){
        showBillingMsg("⚠️ Pago OK, pero aún no se refleja. Revisa el webhook de Stripe o vuelve a abrir esta ventana.");
        clearInterval(timer);
      }
    }, 2000);

    // Quick first refresh
    setTimeout(()=>refreshMe().catch(()=>{}), 500);
  }
}catch(_){ }
/* ---------- Voice + Logo controls ---------- */
const brandBadge = $("#brandBadge");
const voiceFemaleBtn = $("#voiceFemale");
const voiceMaleBtn = $("#voiceMale");
const voiceExactSelect = $("#voiceExactSelect");
const btnTestVoice = $("#btnTestVoice");

const voicePrefKey = "asl_voice_gender";
let voiceGender = "female";
try{
  const v = localStorage.getItem(voicePrefKey);
  if(v === "male" || v === "female") voiceGender = v;
}catch{}

function setVoiceGender(g){
  voiceGender = (g === "male") ? "male" : "female";
  try{ localStorage.setItem(voicePrefKey, voiceGender); }catch{}
  if(voiceFemaleBtn && voiceMaleBtn){
    voiceFemaleBtn.classList.toggle("is-active", voiceGender === "female");
    voiceMaleBtn.classList.toggle("is-active", voiceGender === "male");
    voiceFemaleBtn.setAttribute("aria-pressed", String(voiceGender === "female"));
    voiceMaleBtn.setAttribute("aria-pressed", String(voiceGender === "male"));
  }
}
if(voiceFemaleBtn) voiceFemaleBtn.addEventListener("click", () => setVoiceGender("female"));
if(voiceMaleBtn) voiceMaleBtn.addEventListener("click", () => setVoiceGender("male"));
setVoiceGender(voiceGender);

// Voz exacta (lista de voces)
const voiceExactKey = "asl_voice_exact_v1";
let voiceExact = "";
try{ voiceExact = localStorage.getItem(voiceExactKey) || ""; }catch{}

function setVoiceExact(id){
  voiceExact = id || "";
  try{ localStorage.setItem(voiceExactKey, voiceExact); }catch{}
}

if(voiceExactSelect){
  voiceExactSelect.addEventListener("change", () => setVoiceExact(voiceExactSelect.value));
}

if(btnTestVoice){
  btnTestVoice.addEventListener("click", () => {
    try{ speak("Hello Argus. This is a voice test for ARGUS SPEAK LAB-X.", { lang: "en-US" }); }catch{}
  });
}

// Voices load async on many browsers
let voiceList = [];
function refreshVoices(){
  try{ voiceList = (speechSynthesis.getVoices?.() || []); }catch{ voiceList = []; }
  try{ populateVoiceSelect(); }catch{}
}

function voiceId(v){
  if(!v) return "";
  if(v.voiceURI) return "uri:" + v.voiceURI;
  return "name:" + (v.name||"") + "||" + (v.lang||"");
}

function findVoiceById(id){
  if(!id || !voiceList?.length) return null;
  // New format: uri:... or name:...
  if(id.startsWith("uri:")){
    const uri = id.slice(4);
    return voiceList.find(v => v.voiceURI === uri) || null;
  }
  if(id.startsWith("name:")){
    const rest = id.slice(5);
    const [name, lang] = rest.split("||");
    return voiceList.find(v => (v.name||"") === (name||"") && (v.lang||"") === (lang||""))
        || voiceList.find(v => (v.name||"") === (name||""))
        || null;
  }
  // Legacy / fallback: attempt match by voiceURI or name
  return voiceList.find(v => v.voiceURI === id) || voiceList.find(v => v.name === id) || null;
}

function populateVoiceSelect(){
  if(!voiceExactSelect) return;

  // Ensure we have latest saved preference
  try{ voiceExact = localStorage.getItem(voiceExactKey) || voiceExact || ""; }catch{}

  const voices = Array.from(voiceList||[]);
  voices.sort((a,b) => {
    const ae = String(a.lang||"").toLowerCase().startsWith("en") ? 0 : 1;
    const be = String(b.lang||"").toLowerCase().startsWith("en") ? 0 : 1;
    if(ae !== be) return ae - be;
    const al = String(a.lang||"").localeCompare(String(b.lang||""));
    if(al) return al;
    return String(a.name||"").localeCompare(String(b.name||""));
  });

  voiceExactSelect.innerHTML = "";

  const optAuto = document.createElement("option");
  optAuto.value = "";
  voiceExactSelect.appendChild(optAuto);
  optAuto.textContent = "Auto (por género)";

  for(const v of voices){
    const opt = document.createElement("option");
    opt.value = voiceId(v);
    const isDef = v.default ? " · default" : "";
    opt.textContent = `${v.name} · ${v.lang}${isDef}`;
    voiceExactSelect.appendChild(opt);
  }

  // If the saved voice doesn't exist in this browser, fall back to auto
  voiceExactSelect.value = voiceExact || "";
  if(voiceExact && voiceExactSelect.value !== voiceExact){
    setVoiceExact("");
    voiceExactSelect.value = "";
  }
}

if("speechSynthesis" in window){
  refreshVoices();
  try{ speechSynthesis.addEventListener("voiceschanged", refreshVoices); }catch{}
  setTimeout(refreshVoices, 350);
  setTimeout(refreshVoices, 1200);
}

function scoreVoice(v, lang, gender){
  if(!v) return -999;
  let s = 0;
  const name = `${v.name||""} ${v.voiceURI||""}`.toLowerCase();
  const vlang = (v.lang||"").toLowerCase();
  const target = (lang||"en-us").toLowerCase();

  // Prefer language match
  if(vlang === target) s += 40;
  else if(vlang.startsWith(target.split("-")[0])) s += 28;
  else if(vlang.startsWith("en")) s += 18;

  // Prefer local default
  if(v.default) s += 6;

  // Gender heuristics (best-effort; browsers don't expose gender)
  const femaleHints = /(female|woman|zira|susan|samantha|victoria|karen|kathy|tessa|moira|fiona|ava|allison|emma|linda|joanna|ivy|kimberly|amy|hazel|catherine|serena|michelle|olivia|aria)/i;
  const maleHints   = /(male|man|david|mark|alex|daniel|fred|george|thomas|paul|bruce|ralph|matthew|john|james|robert|brian|andrew|steve|ryan|guy|joey)/i;

  if(gender === "female" && femaleHints.test(name)) s += 22;
  if(gender === "male"   && maleHints.test(name)) s += 22;

  // Penalize opposite hints (softly)
  if(gender === "female" && maleHints.test(name)) s -= 8;
  if(gender === "male"   && femaleHints.test(name)) s -= 8;

  // Slight preference for "Google" / "Microsoft" higher-quality voices
  if(name.includes("google")) s += 6;
  if(name.includes("microsoft")) s += 4;

  return s;
}

function pickVoice(lang, gender){
  if(!voiceList?.length) return null;
  let best = null, bestS = -1e9;
  for(const v of voiceList){
    const s = scoreVoice(v, lang, gender);
    if(s > bestS){ bestS = s; best = v; }
  }
  return best;
}

// Logo "reacts" while speaking (pulse + hit on words)
let logoBeatTimer = null;
let logoHitTO = null;

function bumpLogo(){
  if(!brandBadge) return;
  brandBadge.classList.add("hit");
  if(logoHitTO) window.clearTimeout(logoHitTO);
  logoHitTO = window.setTimeout(() => brandBadge.classList.remove("hit"), 130);
}

function startLogoReact(rate = 1){
  if(!brandBadge) return;
  brandBadge.classList.add("is-speaking-audio");
  const beatMs = Math.max(120, Math.round(220 / (rate || 1)));
  if(logoBeatTimer) window.clearInterval(logoBeatTimer);
  logoBeatTimer = window.setInterval(bumpLogo, beatMs);
}

function stopLogoReact(){
  if(logoBeatTimer){ window.clearInterval(logoBeatTimer); logoBeatTimer = null; }
  if(logoHitTO){ window.clearTimeout(logoHitTO); logoHitTO = null; }
  if(brandBadge){
    brandBadge.classList.remove("is-speaking-audio");
    brandBadge.classList.remove("hit");
  }
}

// Speech recognition (pronunciation check) — best-effort
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let activeListen = null;

function stopListen(){
  try{ if(activeListen) activeListen.stop(); }catch{}
  activeListen = null;
  document.querySelectorAll('.dailyItem.is-listening').forEach(el => el.classList.remove('is-listening'));
  document.querySelectorAll('.btn--mic.is-listening').forEach(el => el.classList.remove('is-listening'));
  document.querySelectorAll('[data-hear]').forEach(el => {
    if(el.dataset.hear === 'listening') el.innerHTML = '';
    delete el.dataset.hear;
  });
}



const views = {
  home: $("#view-home"),
  article: $("#view-article"),
  vocab: $("#view-vocab"),
  daily: $("#view-daily"),
};

const tabs = [...document.querySelectorAll(".tab")];
tabs.forEach(t => t.addEventListener("click", () => setView(t.dataset.view)));

function setView(key){
  try{ stopSpeech(); }catch(e){ console.warn(e); }
  try{ stopListen(); }catch(e){ console.warn(e); }
  try{
    tabs.forEach(t => t.classList.toggle("is-active", t.dataset.view === key));
    Object.entries(views).forEach(([k, el]) => { if(el) el.classList.toggle("is-active", k === key); });
  }catch(e){
    console.warn(e);
    try{ ARGUS_DEBUG.show(e?.stack || e?.message || String(e)); }catch{}
  }
  try{
    window.scrollTo({ top: 0, behavior: "smooth" });
  }catch(_){
    try{ window.scrollTo(0,0); }catch{}
  }
}


/* ---------- Install prompt ---------- */
let deferredPrompt = null;
const btnInstall = $("#btnInstall");
if(btnInstall) btnInstall.style.display = "none";
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  btnInstall.style.display = "inline-flex";
});
if(btnInstall) btnInstall.addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  if(btnInstall) btnInstall.style.display = "none";
});

async function registerSW(){
  if("serviceWorker" in navigator){
    try{ await navigator.serviceWorker.register("./sw.js"); }catch(_){}
  }
}
registerSW();

/* ---------- Text rendering as clickable words ---------- */
function tokenizeToSpans(text){
  const frag = document.createDocumentFragment();
  // words incl apostrophes; punctuation & whitespace preserved
  const tokens = text.match(/[\w’'-]+|[^\w\s]+|\s+/g) || [];
  let pos = 0; // char index in the original string
  for(const tok of tokens){
    if(tok.trim()===""){
      frag.appendChild(document.createTextNode(tok));
    }else if(/^[\w’'-]+$/.test(tok)){
      const s = document.createElement("span");
      s.className = "word";
      s.textContent = tok;
      s.dataset.word = tok;
      s.dataset.start = String(pos);
      s.dataset.end = String(pos + tok.length);
      frag.appendChild(s);
    }else{
      frag.appendChild(document.createTextNode(tok));
    }
    pos += tok.length;
  }
  return frag;
}

/* ---------- Demo text ---------- */
const demoTextEl = $("#demoText");
const demoText = `Hello my name is ARGUS, My day at work starts early. I review tasks, solve problems, and help my team move faster. At the end, I reflect on what improved — and what still needs work.`;
if(demoTextEl) demoTextEl.appendChild(tokenizeToSpans(demoText));

/* ---------- Bottom sheet ---------- */
const sheet = $("#sheet");
const sheetBackdrop = $("#sheetBackdrop");
const sheetClose = $("#sheetClose");
const sheetWord = $("#sheetWord");
const sheetMeta = $("#sheetMeta");
const sheetBody = $("#sheetBody");
const sheetSave = $("#sheetSave");

let selectedWordInfo = null;

function openSheet(){
  sheet.classList.add("is-open");
  sheet.setAttribute("aria-hidden","false");
}
function closeSheet(){
  sheet.classList.remove("is-open");
  sheet.setAttribute("aria-hidden","true");
}
sheetBackdrop.addEventListener("click", closeSheet);
sheetClose.addEventListener("click", closeSheet);

function clearSelectedUI(){
  document.querySelectorAll(".word.is-selected").forEach(w => w.classList.remove("is-selected"));
}

$("#btnClearSelection").addEventListener("click", () => {
  stopSpeech();
  selectedWordInfo = null;
  clearSelectedUI();
  sheetWord.textContent = "—";
  sheetMeta.textContent = "Toca una palabra en el texto";
  sheetBody.innerHTML = "";
});

let activeSpeech = null;

function clearReadingUI(container){
  if(!container) return;
  container.querySelectorAll(".word.is-reading").forEach(el => el.classList.remove("is-reading"));
  container.classList.remove("is-speaking");
}

function buildWordIndex(container){
  const arr = [];
  container.querySelectorAll(".word").forEach(el => {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if(Number.isFinite(start) && Number.isFinite(end)){
      arr.push({ start, end, el });
    }
  });
  arr.sort((a,b) => a.start - b.start);
  return arr;
}

function findWordElByCharIndex(index, charIndex){
  if(!index?.length) return null;
  let lo = 0, hi = index.length - 1, ans = -1;
  while(lo <= hi){
    const mid = (lo + hi) >> 1;
    if(index[mid].start <= charIndex){
      ans = mid;
      lo = mid + 1;
    }else{
      hi = mid - 1;
    }
  }
  if(ans >= 0 && charIndex < index[ans].end) return index[ans].el;
  return null;
}

function maybeScrollIntoView(el){
  if(!el) return;
  const r = el.getBoundingClientRect();
  const pad = 140;
  const vh = window.innerHeight || 800;
  if(r.top < pad || r.bottom > (vh - pad)){
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function stopSpeech(){
  try{
    if("speechSynthesis" in window) speechSynthesis.cancel();
  }catch{}
  if(activeSpeech?.container){
    clearReadingUI(activeSpeech.container);
  }
  activeSpeech = null;
  stopLogoReact();
}

function speak(text, opts = {}){
  if(!("speechSynthesis" in window)) return;
  stopSpeech();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = opts.lang || "en-US";
  u.rate = typeof opts.rate === "number" ? opts.rate : 0.95;

  // Best-effort voice selection (exact voice > gender auto)
  try{
    const vExact = findVoiceById(voiceExact);
    if(vExact){
      u.voice = vExact;
      if(vExact.lang) u.lang = vExact.lang;
    }else{
      const v = pickVoice(u.lang, voiceGender);
      if(v) u.voice = v;
    }
  }catch{}

  // Make the logo react while speaking
  u.onstart = () => { try{ startLogoReact(u.rate); }catch{} };

  const container = opts.container || null;
  let index = null;

  if(container){
    index = buildWordIndex(container);
    container.classList.add("is-speaking");
    activeSpeech = { container, index, lastEl: null };

    // Fallback: si el navegador no soporta onboundary, avanzamos palabra por palabra con un timer.
    let boundaryUsed = false;
    let timer = null;
    let fallbackI = 0;
    const fallbackStepMs = Math.max(90, Math.round(260 / (u.rate || 1)));

    timer = window.setInterval(() => {
      if(boundaryUsed) return;
      const item = index[fallbackI++];
      if(!item){
        window.clearInterval(timer);
        timer = null;
        return;
      }
      const el = item.el;
      if(activeSpeech?.lastEl && activeSpeech.lastEl !== el){
        activeSpeech.lastEl.classList.remove("is-reading");
      }
      el.classList.add("is-reading");
      activeSpeech.lastEl = el;
      if(opts.follow) maybeScrollIntoView(el);
      bumpLogo();
    }, fallbackStepMs);

    u.onboundary = (e) => {
      boundaryUsed = true;
      if(timer){ window.clearInterval(timer); timer = null; }
      // Chrome/Edge usually emit word boundaries con charIndex.
      const ci = typeof e.charIndex === "number" ? e.charIndex : 0;
      const el = findWordElByCharIndex(index, ci);
      if(!el) return;

      if(activeSpeech?.lastEl && activeSpeech.lastEl !== el){
        activeSpeech.lastEl.classList.remove("is-reading");
      }
      el.classList.add("is-reading");
      activeSpeech.lastEl = el;

      if(opts.follow) maybeScrollIntoView(el);
      bumpLogo();
    };

    const cleanup = () => {
      stopLogoReact();
      if(timer){ window.clearInterval(timer); timer = null; }
      if(activeSpeech?.container === container){
        clearReadingUI(container);
        activeSpeech = null;
      }else{
        clearReadingUI(container);
      }
    };

    u.onend = cleanup;
    u.onerror = cleanup;
  }

  if(!container){
    u.onend = () => stopLogoReact();
    u.onerror = () => stopLogoReact();
  }

  speechSynthesis.speak(u);
}
$("#btnReadDemo").addEventListener("click", () => speak(demoText, { container: demoTextEl }));

/* ---------- AI client ---------- */
function setBusy(btn, busy, label){
  if(!btn) return;
  btn.disabled = !!busy;
  btn.dataset._label = btn.dataset._label || btn.textContent;
  btn.textContent = busy ? label : btn.dataset._label;
}


async function callAI(task, payload){
  const headers = { "Content-Type":"application/json", ...authHeaders() };
  const res = await fetch(apiEndpoint("ai"), {
    method:"POST",
    headers,
    body: JSON.stringify({ task, payload })
  });

  if(!res.ok){
    const t = await res.text().catch(()=> "");
    // 401/402 -> show account modal to unlock
    if(res.status === 401 || res.status === 402 || res.status === 429){
      openAccountModal();
    }
    throw new Error(t || `AI error (${res.status})`);
  }
  return await res.json();
}

function safeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function renderWordIntel(info){
  const ipa = info.ipa ? `<span class="badge">${safeHtml(info.ipa)}</span>` : "";
  const pron = info.pronunciation_hint ? `<div class="muted">Pronunciación fácil: <b>${safeHtml(info.pronunciation_hint)}</b></div>` : "";
  const warnings = (info.warnings||[]).length ? `<div class="muted">Ojo: ${safeHtml(info.warnings.join(" · "))}</div>` : "";
  const synonyms = (info.synonyms||[]).length ? `<div class="muted">Sinónimos: ${safeHtml(info.synonyms.join(", "))}</div>` : "";

  sheetBody.innerHTML = `
    <div class="output">
      <div><b>Traducción:</b> ${safeHtml(info.translation || "—")} ${ipa}</div>
      <div class="muted" style="margin-top:6px;"><b>Significado:</b> ${safeHtml(info.meaning || "—")}</div>
      <div style="margin-top:10px;"><b>Uso (formal):</b> ${safeHtml(info.example_formal || "—")}</div>
      <div style="margin-top:6px;"><b>Uso (casual):</b> ${safeHtml(info.example_casual || "—")}</div>
      <div style="margin-top:10px;">${pron}</div>
      <div style="margin-top:8px;">${synonyms}</div>
      <div style="margin-top:8px;">${warnings}</div>
    </div>
  `;
}

function getCurrentContextText(){
  const articleText = $("#articleInput")?.value?.trim();
  if(articleText) return articleText.slice(0, 1200);
  return demoText;
}

/* ---------- Word click handler (delegated) ---------- */
document.body.addEventListener("click", async (e) => {
  const el = e.target.closest(".word");
  if(!el) return;

  clearSelectedUI();
  el.classList.add("is-selected");

  const w = (el.dataset.word || el.textContent || "").trim();
  if(!w) return;

  selectedWordInfo = null;
  sheetWord.textContent = w;
  sheetMeta.textContent = "Analizando con IA…";
  sheetBody.innerHTML = `<div class="output">⚡ Laboratorio activado. Dame 1 segundo mental…</div>`;
  openSheet();

  setBusy(sheetSave, true, "…");
  try{
    const data = await callAI("word_info", { word: w, context: getCurrentContextText() });
    selectedWordInfo = data.word_info;
    sheetMeta.textContent = "Listo. Esto sí es aprender.";
    renderWordIntel(selectedWordInfo);
    sheetSave.disabled = false;
  }catch(err){
    sheetMeta.textContent = "Falló la IA (no tú).";
    sheetBody.innerHTML = `<div class="output">Error: ${safeHtml(err.message)}</div>`;
    sheetSave.disabled = true;
  }finally{
    setBusy(sheetSave, false, "Guardar");
  }
});

/* ---------- Save vocab ---------- */
const savedKey = "argus_speak_saved_v1";
const savedList = $("#savedList");

function loadSaved(){
  try{ return JSON.parse(localStorage.getItem(savedKey) || "[]"); }catch{ return []; }
}
function saveSaved(arr){ localStorage.setItem(savedKey, JSON.stringify(arr.slice(0, 200))); }

function renderSaved(){
  const arr = loadSaved();
  savedList.innerHTML = "";
  if(!arr.length){
    savedList.innerHTML = `<div class="muted">Sin palabras guardadas. Toca una palabra y guárdala.</div>`;
    return;
  }
  for(const item of arr){
    const div = document.createElement("div");
    div.className = "cardMini";
    div.innerHTML = `
      <div class="cardMini__w">${safeHtml(item.word)} <span class="badge">${safeHtml(item.translation||"")}</span></div>
      <div class="cardMini__m">${safeHtml(item.ipa||"")} · ${safeHtml(item.pronunciation_hint||"")}</div>
      <div class="cardMini__ex">${safeHtml(item.example_casual||item.example_formal||"")}</div>
      <div class="cardMini__row">
        <button class="btn btn--soft" data-say="${safeHtml(item.word)}">🔊</button>
        <button class="btn btn--ghost" data-del="${safeHtml(item.word)}">Eliminar</button>
      </div>
    `;
    savedList.appendChild(div);
  }
  savedList.querySelectorAll("[data-say]").forEach(b => b.addEventListener("click", () => speak(b.dataset.say)));
  savedList.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    const w = b.dataset.del;
    const arr2 = loadSaved().filter(x => x.word !== w);
    saveSaved(arr2);
    renderSaved();
  }));
}
renderSaved();

$("#btnSaveSelected").addEventListener("click", () => {
  if(!selectedWordInfo) return alert("Primero toca una palabra y deja que la IA la analice.");
  const arr = loadSaved();
  if(arr.some(x => x.word.toLowerCase() === selectedWordInfo.word.toLowerCase())) return alert("Esa palabra ya está guardada.");
  arr.unshift(selectedWordInfo);
  saveSaved(arr);
  renderSaved();
  setView("vocab");
});

$("#btnClearSaved").addEventListener("click", () => {
  if(confirm("¿Borrar todas las palabras guardadas?")){
    saveSaved([]);
    renderSaved();
  }
});

sheetSave.addEventListener("click", () => {
  if(!selectedWordInfo) return;
  const arr = loadSaved();
  if(arr.some(x => x.word.toLowerCase() === selectedWordInfo.word.toLowerCase())) return alert("Esa palabra ya está guardada.");
  arr.unshift(selectedWordInfo);
  saveSaved(arr);
  renderSaved();
  alert("Guardada. Esa palabra ya es tuya.");
});

/* ---------- Article view ---------- */
const articleInput = $("#articleInput");
const articleRendered = $("#articleRendered");
let lastWordPanel = null;

$("#btnRenderArticle").addEventListener("click", () => {
  const t = articleInput.value.trim();
  if(!t) return alert("Pega un artículo primero.");
  stopSpeech();
  articleRendered.innerHTML = "";
  articleRendered.appendChild(tokenizeToSpans(t));
  setView("article");
});


$("#btnReadArticle").addEventListener("click", () => {
  const t = articleInput.value.trim();
  if(!t) return alert("Pega un artículo primero.");

  // Auto‑preparar si el usuario no presionó “Preparar lectura”
  if(!articleRendered.textContent.trim()){
    articleRendered.innerHTML = "";
    articleRendered.appendChild(tokenizeToSpans(t));
  }

  speak(t.slice(0, 2500), { container: articleRendered, follow: true });
});

$("#btnClearArticle").addEventListener("click", () => {
  stopSpeech();
  articleInput.value = "";
  articleRendered.innerHTML = "";
  clearSelectedUI();
  selectedWordInfo = null;
  resetWordPanel();
  closeSheet();
  articleInput.focus();
});


/* Word Intel side panel */
const wordPanelBody = $("#wordPanelBody");
const btnSpeakWord = $("#btnSpeakWord");
const btnQuizWord = $("#btnQuizWord");
const wordPanelDefault = wordPanelBody.innerHTML;

function resetWordPanel(){
  lastWordPanel = null;
  wordPanelBody.innerHTML = wordPanelDefault;
  btnSpeakWord.disabled = true;
  btnQuizWord.disabled = true;
}

function setWordPanel(info){
  lastWordPanel = info;
  wordPanelBody.innerHTML = `
    <div><b>${safeHtml(info.word)}</b> <span class="badge">${safeHtml(info.translation||"")}</span></div>
    <div class="muted" style="margin-top:6px;">${safeHtml(info.meaning||"")}</div>
    <div style="margin-top:10px;"><b>Formal:</b> ${safeHtml(info.example_formal||"")}</div>
    <div style="margin-top:6px;"><b>Casual:</b> ${safeHtml(info.example_casual||"")}</div>
    <div class="muted" style="margin-top:10px;"><b>IPA:</b> ${safeHtml(info.ipa||"—")} · <b>Guía:</b> ${safeHtml(info.pronunciation_hint||"—")}</div>
    ${(info.synonyms||[]).length ? `<div class="muted" style="margin-top:8px;">Sinónimos: ${safeHtml(info.synonyms.join(", "))}</div>` : ""}
    ${(info.warnings||[]).length ? `<div class="muted" style="margin-top:8px;">Ojo: ${safeHtml(info.warnings.join(" · "))}</div>` : ""}
  `;
  btnSpeakWord.disabled = false;
  btnSpeakWord.onclick = () => speak(info.word);
  btnQuizWord.disabled = false;
}
btnSpeakWord.addEventListener("click", () => { if(lastWordPanel) speak(lastWordPanel.word); });

btnQuizWord.addEventListener("click", async () => {
  if(!lastWordPanel) return;
  btnQuizWord.disabled = true;
  btnQuizWord.textContent = "Generando…";
  try{
    const data = await callAI("quiz_word", { word_info: lastWordPanel });
    const q = data.quiz;
    const ans = prompt(`${q.question}\n\nA) ${q.choices[0]}\nB) ${q.choices[1]}\nC) ${q.choices[2]}\nD) ${q.choices[3]}\n\nEscribe A/B/C/D:`);
    if(!ans) return;
    const idx = "ABCD".indexOf(ans.trim().toUpperCase());
    if(idx === q.correct_index){
      alert("✅ OK. Bien jugado.");
    }else{
      alert(`❌ Vuelve a intentar.\nRespuesta correcta: ${"ABCD"[q.correct_index]}\n\nTip: ${q.explanation}`);
    }
  }catch(err){
    alert("Error en quiz: " + err.message);
  }finally{
    btnQuizWord.disabled = false;
    btnQuizWord.textContent = "Mini‑quiz";
  }
});

const observer = new MutationObserver(() => {
  if(selectedWordInfo && views.article.classList.contains("is-active")){
    setWordPanel(selectedWordInfo);
  }
});
observer.observe(sheetBody, { childList:true, subtree:true });

/* ---------- Quick ask + explain selected sentence ---------- */
const quickOutput = $("#quickOutput");

$("#btnAskAI").addEventListener("click", async () => {
  const q = $("#quickAsk").value.trim();
  if(!q) return alert("Escribe una pregunta.");
  setBusy($("#btnAskAI"), true, "Pensando…");
  quickOutput.hidden = true;
  try{
    const data = await callAI("ask", { question: q, context: getCurrentContextText() });
    quickOutput.innerHTML = safeHtml(data.answer);
    quickOutput.hidden = false;
  }catch(err){
    quickOutput.innerHTML = "Error: " + safeHtml(err.message);
    quickOutput.hidden = false;
  }finally{
    setBusy($("#btnAskAI"), false, "Preguntar");
  }
});

$("#btnExplainSentence").addEventListener("click", async () => {
  const sel = window.getSelection()?.toString()?.trim();
  if(!sel) return alert("Selecciona una oración (arrastrando) y luego presiona este botón.");
  setBusy($("#btnExplainSentence"), true, "Explicando…");
  quickOutput.hidden = true;
  try{
    const data = await callAI("explain_sentence", { sentence: sel, context: getCurrentContextText() });
    quickOutput.innerHTML = safeHtml(data.explanation);
    quickOutput.hidden = false;
  }catch(err){
    quickOutput.innerHTML = "Error: " + safeHtml(err.message);
    quickOutput.hidden = false;
  }finally{
    setBusy($("#btnExplainSentence"), false, "Explicar oración seleccionada");
  }
});

$("#btnSummarize").addEventListener("click", async () => {
  const t = articleInput.value.trim();
  if(!t) return alert("Pega un artículo primero.");
  setBusy($("#btnSummarize"), true, "Resumiendo…");
  try{
    const data = await callAI("summarize", { text: t.slice(0, 6000) });
    alert("Resumen:\n\n" + data.summary);
  }catch(err){
    alert("Error resumen: " + err.message);
  }finally{
    setBusy($("#btnSummarize"), false, "Resumen (IA)");
  }
});

/* ---------- Daily words ---------- */
const dailyKey = "argus_daily_v1";
const dailyGrid = $("#dailyGrid");


function renderDaily(items){
  dailyGrid.innerHTML = "";
  if(!items?.length){
    dailyGrid.innerHTML = `<div class="muted">Genera tus 10 palabras. Hoy se entrena.</div>`;
    return;
  }

  items.forEach((it, i) => {
    const div = document.createElement("div");
    div.className = "dailyItem";
    div.dataset.idx = String(i);

    const statusBadge = it.status === "ok"
      ? `<span class="badge ok">✅ OK</span>`
      : it.status === "retry"
        ? `<span class="badge bad">❌ Repite</span>`
        : `<span class="badge">Pendiente</span>`;

    const heardLine = it.last_heard
      ? `<span class="hearChip"><span class="hearDot"></span>Oí: “${safeHtml(it.last_heard)}”</span>`
      : `<span class="hearChip"><span class="hearDot"></span>Presiona 🎤 y pronuncia la palabra</span>`;

    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div><b>${i+1}. ${safeHtml(it.word)}</b> <span class="badge">${safeHtml(it.translation||"")}</span></div>
        <div>${statusBadge}</div>
      </div>
      <div class="muted" style="margin-top:6px;">${safeHtml(it.ipa||"")} · ${safeHtml(it.pronunciation_hint||"")}</div>
      <div style="margin-top:10px;">${safeHtml(it.example||"")}</div>
      <div class="row">
        <button class="btn btn--soft" data-say="${safeHtml(it.word)}">🔊</button>
        <button class="btn btn--mic" data-practice="${i}">🎤 Practicar</button>
        <button class="btn btn--primary" data-ok="${i}">OK</button>
        <button class="btn btn--ghost" data-retry="${i}">Vuelve a intentar</button>
      </div>
      <div class="dailyHear" id="dailyHear-${i}">${heardLine}</div>
    `;
    dailyGrid.appendChild(div);
  });

  dailyGrid.querySelectorAll("[data-say]").forEach(b => b.addEventListener("click", () => speak(b.dataset.say)));
  dailyGrid.querySelectorAll("[data-ok]").forEach(b => b.addEventListener("click", () => setDailyStatus(+b.dataset.ok, "ok")));
  dailyGrid.querySelectorAll("[data-retry]").forEach(b => b.addEventListener("click", () => setDailyStatus(+b.dataset.retry, "retry")));
  dailyGrid.querySelectorAll("[data-practice]").forEach(b => b.addEventListener("click", () => practiceDaily(+b.dataset.practice)));
}


function loadDaily(){
  try{ return JSON.parse(localStorage.getItem(dailyKey) || "null"); }catch{ return null; }
}
function saveDaily(data){ localStorage.setItem(dailyKey, JSON.stringify(data)); }



function updateDailyItem(idx, patch){
  const data = loadDaily();
  if(!data?.items?.[idx]) return;
  Object.assign(data.items[idx], patch);
  saveDaily(data);
}

function getDailyItemEl(idx){
  return dailyGrid.querySelector(`.dailyItem[data-idx="${idx}"]`);
}

function flashDaily(idx, ok){
  const el = getDailyItemEl(idx);
  if(!el) return;
  el.classList.remove('flash-ok','flash-bad');
  el.classList.add(ok ? 'flash-ok' : 'flash-bad');
  window.setTimeout(() => el.classList.remove('flash-ok','flash-bad'), 720);
}

function normalizeSpeechText(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[“”"'’]/g, "")
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGoodPronunciation(expected, heard){
  const e = normalizeSpeechText(expected);
  const h = normalizeSpeechText(heard);
  if(!e || !h) return false;
  if(h === e) return true;
  const ht = h.split(' ');
  // allow if transcript contains the expected token
  if(!e.includes(' ') && ht.includes(e)) return true;
  // allow if it's a phrase and transcript contains it
  if(e.includes(' ') && h.includes(e)) return true;
  // mild tolerance: one missing trailing "s" (plurals)
  if(!e.includes(' ') && (h === e + 's' || e === h + 's')) return true;
  return false;
}

async function practiceDaily(idx){
  const data = loadDaily();
  const it = data?.items?.[idx];
  if(!it) return;

  if(!SpeechRecognition){
    alert("Tu navegador no soporta reconocimiento de voz.\n\nTip: usa Chrome/Edge (Android o PC) y abre la app en HTTPS.");
    return;
  }

  stopListen();
  stopSpeech();

  const expected = String(it.word || '').trim();
  if(!expected) return;

  const itemEl = getDailyItemEl(idx);
  const hearEl = document.getElementById(`dailyHear-${idx}`);
  const btn = dailyGrid.querySelector(`[data-practice="${idx}"]`);

  if(itemEl) itemEl.classList.add('is-listening');
  if(btn) btn.classList.add('is-listening');

  const show = (html, listening=false) => {
    if(!hearEl) return;
    if(listening){
      hearEl.dataset.hear = 'listening';
      hearEl.innerHTML = `<span class="hearChip"><span class="hearDot"></span>${html}</span>`;
    }else{
      delete hearEl.dataset.hear;
      hearEl.innerHTML = html;
    }
  };

  show(`Escuchando… di: <b>${safeHtml(expected)}</b>`, true);

  const rec = new SpeechRecognition();
  activeListen = rec;
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  try{ rec.maxAlternatives = 3; }catch{}

  let finalText = '';

  rec.onresult = (event) => {
    let interim = '';
    for(let i = event.resultIndex; i < event.results.length; i++){
      const r = event.results[i];
      const txt = (r?.[0]?.transcript || '').trim();
      if(r.isFinal) finalText += (finalText ? ' ' : '') + txt;
      else interim += (interim ? ' ' : '') + txt;
    }
    const showTxt = (finalText || interim || '').trim();
    if(showTxt){
      show(`Escuchando… di: <b>${safeHtml(expected)}</b> · Oí: “${safeHtml(showTxt)}”`, true);
    }
  };

  rec.onerror = (e) => {
    stopListen();
    const msg = e?.error ? String(e.error) : 'unknown';
    alert("No pude escuchar (mic).\n\n" + msg + "\n\nTip: permite el micrófono y usa HTTPS.");
  };

  rec.onend = () => {
    const heard = (finalText || '').trim();
    const ok = isGoodPronunciation(expected, heard);

    const attempts = (it.attempts || 0) + 1;
    updateDailyItem(idx, {
      attempts,
      last_heard: heard || it.last_heard || '',
      status: ok ? 'ok' : 'retry'
    });

    stopListen();
    renderDaily(loadDaily()?.items || []);
    flashDaily(idx, ok);

    if(!ok){
      try{ speak(expected); }catch{}
    }
  };

  try{ rec.start(); }
  catch(err){
    stopListen();
    alert('No se pudo iniciar el micrófono: ' + (err?.message || err));
  }
}

function setDailyStatus(idx, status){
  const data = loadDaily();
  if(!data?.items) return;
  data.items[idx].status = status;
  saveDaily(data);
  renderDaily(data.items);
}

const existing = loadDaily();
if(existing?.items) renderDaily(existing.items); else renderDaily([]);

$("#btnGenerateDaily").addEventListener("click", async () => {
  const topic = $("#dailyTopic").value;
  setBusy($("#btnGenerateDaily"), true, "Generando…");
  try{
    const data = await callAI("daily_words", { topic, n: 10 });
    saveDaily({ date: new Date().toISOString().slice(0,10), topic, items: data.words.map(w => ({...w, status:"pending"})) });
    renderDaily(loadDaily().items);
    setView("daily");
  }catch(err){
    alert("Error generando: " + err.message);
  }finally{
    setBusy($("#btnGenerateDaily"), false, "Generar 10");
  }
});

$("#btnResetDaily").addEventListener("click", () => {
  if(confirm("¿Reiniciar la lista de hoy?")){
    localStorage.removeItem(dailyKey);
    renderDaily([]);
  }
});

/* ---------- AI check ---------- */
const btnCheckAI = $("#btnCheckAI");
if(btnCheckAI){
  btnCheckAI.addEventListener("click", async () => {
    if(!meState.pro){
      openAccountModal();
      showBillingMsg("Para usar IA necesitas Plan PRO.");
      return;
    }
    setBusy(btnCheckAI, true, "Probando…");
    try{
      const data = await callAI("ping", {});
      alert("✅ IA lista.\n\n" + (data?.pong || "OK"));
    }catch(err){
      const msg = err?.message || String(err || "Error");
      alert("❌ IA no conectó.\n\n" + msg + "\n\nTip: revisa variables OPENAI_API_KEY y el plan PRO.");
    }finally{
      setBusy(btnCheckAI, false, "Probar IA");
    }
  });
}
