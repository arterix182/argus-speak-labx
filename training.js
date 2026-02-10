/*
  LABX Training (7 min) - módulo ligero, cargado bajo demanda.
  Usa callAI('ask', ...) para orquestar el entrenamiento sin tocar el backend.

  Nota: Mantén esto simple. Si el usuario no está logueado, igual funciona.
*/

(function(){
  const $ = (q) => document.querySelector(q);

  const pill = () => $("#trainingStepPill");
  const title = () => $("#trainingStepTitle");
  const stage = () => $("#trainingStage");
  const controls = () => $("#trainingControls");
  const btnSpeak = () => $("#trainingSpeak");
  const btnNext = () => $("#trainingNext");

  const chat = () => $("#trainingChat");
  const chatLog = () => $("#trainingChatLog");
  const userInput = () => $("#trainingUserInput");
  const btnSend = () => $("#trainingSend");

  const autopsyBox = () => $("#trainingAutopsy");
  const autopsyOut = () => $("#trainingAutopsyOut");
  const repeatBox = () => $("#trainingRepeat");
  const repeatOut = () => $("#trainingRepeatOut");

  const topicEl = () => $("#trainingTopic");
  const btnStart = () => $("#trainingStart");
  const btnReset = () => $("#trainingReset");

  const state = {
    step: 0,
    topic: "",
    prompt: "",
    convo: [],
    shadowSentence: ""
  };

  function setStep(n, label){
    state.step = n;
    if(pill()) pill().textContent = label || `Paso ${n}`;
  }

  function esc(str){ return String(str||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

  function log(role, text){
    state.convo.push({ role, text: String(text||"") });
    if(!chatLog()) return;
    const div = document.createElement("div");
    div.style.margin = "8px 0";
    div.innerHTML = `<div class="muted" style="font-size:12px">${esc(role)}</div><div>${esc(text)}</div>`;
    chatLog().appendChild(div);
    chatLog().scrollTop = chatLog().scrollHeight;
  }

  function resetUI(){
    setStep(0, "Listo");
    if(title()) title().textContent = "Pulsa “Iniciar sesión”";
    if(stage()) stage().textContent = "Esto funciona incluso si no tienes cuenta. Si inicias sesión, guardará tu progreso.";
    if(controls()) controls().style.display = "none";
    if(chat()) chat().style.display = "none";
    if(autopsyBox()) autopsyBox().style.display = "none";
    if(repeatBox()) repeatBox().style.display = "none";
    if(chatLog()) chatLog().innerHTML = "";
    if(userInput()) userInput().value = "";
    state.convo = [];
    state.prompt = "";
    state.shadowSentence = "";
  }

  function speak(text){
    try{
      if(!("speechSynthesis" in window)) return alert("Este navegador no soporta Text-to-Speech.");
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text||""));
      u.lang = "en-US";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    }catch(e){
      console.warn(e);
    }
  }

  async function step1_shadowing(){
    setStep(1, "1/4 Shadowing");
    if(title()) title().textContent = "Shadowing (30–45s)";
    state.shadowSentence = `Today I want to talk about ${state.topic || "my day"}.`;
    if(stage()) stage().innerHTML = `
      Repite esta frase en voz alta, 3 veces, intentando sonar natural:<br><br>
      <b>${esc(state.shadowSentence)}</b><br><br>
      1) Pulsa “Escuchar”. 2) Repite encima. 3) Cuando te salga, “Continuar”.
    `;
    if(controls()) controls().style.display = "flex";
    if(btnSpeak()) btnSpeak().onclick = ()=> speak(state.shadowSentence);
    if(btnNext()) btnNext().onclick = ()=> step2_conversation().catch(err => alert(err.message));
    if(chat()) chat().style.display = "none";
  }

  async function step2_conversation(){
    setStep(2, "2/4 Conversación");
    if(title()) title().textContent = "Conversación (3 min)";
    if(stage()) stage().textContent = "Responde en inglés. La app te corrige y te hace la siguiente pregunta.";
    if(controls()) controls().style.display = "none";
    if(chat()) chat().style.display = "block";
    if(autopsyBox()) autopsyBox().style.display = "none";
    if(repeatBox()) repeatBox().style.display = "none";

    // Primera pregunta del coach
    const qPrompt = [
      "You are an English conversation partner and coach.",
      `Topic: ${state.topic || "daily life"}.`,
      "Ask ONE short question to start. Keep it A2-B1 friendly.",
      "Return only the question."
    ].join("\n");

    const data = await callAI("ask", { question: qPrompt, context: "" });
    const coachQ = (data?.answer || "").trim() || "Tell me about your day.";
    state.prompt = coachQ;

    log("Coach", coachQ);

    if(btnSend()){
      btnSend().onclick = async ()=>{
        const ans = (userInput()?.value||"").trim();
        if(!ans) return;
        userInput().value = "";
        log("You", ans);

        const coachPrompt = [
          "You are an English coach. Be direct, helpful, and brief.",
          `Topic: ${state.topic || "daily life"}.`,
          "Given the user's answer, do:",
          "1) Provide a corrected version (same meaning).",
          "2) Provide ONE more natural version.",
          "3) Give 2 micro-notes (grammar/vocab/pronunciation tips).",
          "4) Ask the next short question.",
          "",
          `Coach question: ${state.prompt}`,
          `User answer: ${ans}`,
          "",
          "Output format:",
          "Corrected: ...",
          "Natural: ...",
          "Notes: - ... - ...",
          "Next question: ..."
        ].join("\n");

        const r = await callAI("ask", { question: coachPrompt, context: "" });
        const out = (r?.answer || "").trim();
        log("Coach", out);

        // intenta extraer la siguiente pregunta para mantener el loop
        const m = out.match(/Next question:\s*(.*)/i);
        state.prompt = (m && m[1]) ? m[1].trim() : state.prompt;

      };
    }

    // Botón para saltar a autopsia
    const jump = document.createElement("button");
    jump.className = "btn";
    jump.textContent = "Ir a Autopsia";
    jump.style.marginTop = "10px";
    jump.onclick = ()=> step3_autopsy().catch(err=> alert(err.message));
    stage().appendChild(jump);
  }

  async function step3_autopsy(){
    setStep(3, "3/4 Autopsia");
    if(title()) title().textContent = "Autopsia (2 min)";
    if(chat()) chat().style.display = "none";
    if(autopsyBox()) autopsyBox().style.display = "block";
    if(repeatBox()) repeatBox().style.display = "none";

    const transcript = state.convo.map(x=> `${x.role}: ${x.text}`).join("\n").slice(0, 2500);

    const prompt = [
      "You are an English coach. Analyze the transcript and create an 'Error Footprint'.",
      "Be concise and practical. A2-B2 friendly.",
      "",
      "Output as:",
      "Top Patterns:",
      "- (pattern) -> (1 fix)",
      "- ...",
      "",
      "Upgrade Phrases (5):",
      "- phrase",
      "",
      "Mini Drill (60s):",
      "Give 3 short prompts to answer using the upgraded phrases.",
      "",
      "Transcript:",
      transcript
    ].join("\n");

    const r = await callAI("ask", { question: prompt, context: "" });
    const out = (r?.answer || "").trim();
    if(autopsyOut()) autopsyOut().innerHTML = safeHtml ? safeHtml(out) : esc(out);

    // Guarda si hay sesión/logueo
    try{
      const sb = window.LABX?.getSupabase?.();
      const sess = window.LABX?.getSession?.();
      if(sb && sess?.access_token){
        await sb.from("labx_training_sessions").insert([{
          topic: state.topic || null,
          transcript,
          autopsy: out,
          created_at: new Date().toISOString()
        }]);
      }
    }catch(e){
      console.warn("No se pudo guardar sesión:", e);
    }

    // Continuar a repetición
    if(repeatBox()) repeatBox().style.display = "block";
    await step4_repeat(out);
  }

  async function step4_repeat(autopsyText){
    setStep(4, "4/4 Repetición");
    if(title()) title().textContent = "Repetición mejorada (1–2 min)";
    if(stage()) stage().textContent = "Repite con una versión mejorada. Copia/pega y léelo en voz alta.";
    if(repeatBox()) repeatBox().style.display = "block";

    const prompt = [
      "You are an English coach. Create a short improved paragraph the user can read aloud.",
      `Topic: ${state.topic || "daily life"}.`,
      "Use simple natural English. 3-5 sentences.",
      "Incorporate the upgraded phrases if mentioned.",
      "",
      "Autopsy:",
      String(autopsyText||"").slice(0, 1500)
    ].join("\n");

    const r = await callAI("ask", { question: prompt, context: "" });
    const out = (r?.answer || "").trim();
    if(repeatOut()) repeatOut().innerHTML = safeHtml ? safeHtml(out) : esc(out);

    // activar botón escuchar aquí
    if(controls()) controls().style.display = "flex";
    if(btnSpeak()) btnSpeak().onclick = ()=> speak(out.replace(/\n+/g," "));
    if(btnNext()){
      btnNext().textContent = "Terminar";
      btnNext().onclick = ()=> {
        setStep(0, "Listo");
        if(title()) title().textContent = "Sesión completada ✅";
        if(stage()) stage().innerHTML = `Perfecto. Repite tu párrafo 2 veces hoy y 1 vez mañana. <b>Consistencia mata talento</b>.`;
        if(controls()) controls().style.display = "none";
      };
    }
  }

  async function start(){
    resetUI();
    state.topic = (topicEl()?.value || "").trim();
    if(!state.topic) state.topic = "daily life";
    // Asegura auth inicializado (si existe) pero no es obligatorio
    try{ window.LABX?.ensureAuthInit?.(); }catch(e){}
    await step1_shadowing();
  }

  async function init(){
    // Evita doble init
    if(window.__LABX_TRAINING_INITED) return;
    window.__LABX_TRAINING_INITED = true;

    if(!$("#view-training")) return; // si no existe, no hacemos nada

    resetUI();

    if(btnStart()) btnStart().addEventListener("click", ()=> start().catch(err=> alert(err.message)));
    if(btnReset()) btnReset().addEventListener("click", resetUI);

    // Si el usuario llega directo a la pestaña, todo listo.
  }

  window.LABX_TRAINING = { init };
})();
