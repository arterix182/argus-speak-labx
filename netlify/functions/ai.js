// Netlify Edge Function: /api/ai
// ✅ IA con OpenAI (OPENAI_API_KEY) + candado PRO con Supabase (sin issuer drama en el frontend).
//
// Cómo funciona:
// - El frontend manda Authorization: Bearer <supabase_access_token>
// - Esta función valida el token con Supabase Auth (solo para sacar user.id)
// - Luego consulta `profiles` con service key para saber si es PRO
// - Si NO es PRO -> 402 (PRO_REQUIRED) y NO se llama a OpenAI
//
// Variables de entorno (Netlify):
// - OPENAI_API_KEY              (obligatoria)
// - OPENAI_MODEL                (opcional, default: gpt-5.2)
// - SUPABASE_URL                (obligatoria si REQUIRE_PRO=1)
// - SUPABASE_ANON_KEY           (sb_publishable_...)
// - SUPABASE_SERVICE_ROLE_KEY   (sb_secret_...)  (o SUPABASE_SERVICE_ROLE como alias)
// - REQUIRE_PRO                 (default: "1")  -> "0" para dejar IA libre (no recomendado)

function getEnv(k){
  // Edge runtime (Netlify) + compat con otros runtimes
  try{
    // eslint-disable-next-line no-undef
    if(typeof Netlify !== "undefined" && Netlify.env?.get) return Netlify.env.get(k);
  }catch(_){}
  try{
    // eslint-disable-next-line no-undef
    if(typeof Deno !== "undefined" && Deno.env?.get) return Deno.env.get(k);
  }catch(_){}
  try{
    // eslint-disable-next-line no-undef
    if(typeof process !== "undefined" && process.env) return process.env[k];
  }catch(_){}
  return undefined;
}

function json(body, status=200){
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type":"application/json" }
  });
}

function normalizeUrl(u){
  return String(u||"").replace(/\/$/, "");
}

async function getSupabaseUserId(req, supabaseUrl, anonKey){
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if(!m) return { ok:false, status: 401, error: "NO_TOKEN" };

  const token = m[1].trim();
  const r = await fetch(`${normalizeUrl(supabaseUrl)}/auth/v1/user`, {
    headers: {
      "apikey": anonKey,
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    }
  });

  const txt = await r.text();
  if(!r.ok){
    // No cerramos sesión aquí; solo devolvemos un error “vuelve a iniciar”
    // (así evitas que seleccionar una palabra te expulse).
    return { ok:false, status: 401, error: "BAD_SESSION", details: txt.slice(0, 240) };
  }

  let user = null;
  try{ user = JSON.parse(txt); }catch(_){}
  if(!user?.id) return { ok:false, status: 401, error: "BAD_SESSION" };

  return { ok:true, userId: user.id };
}

async function isProUser(userId, supabaseUrl, serviceKey){
  const url = `${normalizeUrl(supabaseUrl)}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status,subscription_current_period_end`;
  const r = await fetch(url, {
    headers: { "apikey": serviceKey, "Authorization": `Bearer ${serviceKey}` }
  });
  if(!r.ok) return false;

  const rows = await r.json().catch(()=>[]);
  const profile = rows?.[0] || null;

  const st = String(profile?.subscription_status || "").toLowerCase();
  if(st !== "active" && st !== "trialing") return false;

  const end = profile?.subscription_current_period_end ? Date.parse(profile.subscription_current_period_end) : NaN;
  if(!Number.isNaN(end) && end < Date.now() - 60_000) return false;

  return true;
}

export default async (req) => {
  try{
    if(req.method !== "POST"){
      return new Response("Method not allowed", { status: 405 });
    }

    const { task, payload } = await req.json().catch(()=> ({}));

    // Cheap health-check without calling OpenAI
    if(task === "ping"){
      return json({ pong: "PRO_AI_READY" }, 200);
    }

    const requirePro = String(getEnv("REQUIRE_PRO") ?? "1") !== "0";
    if(requirePro){
      const supabaseUrl = getEnv("SUPABASE_URL");
      const anonKey = getEnv("SUPABASE_ANON_KEY") || getEnv("VITE_SUPABASE_ANON_KEY");
      const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || getEnv("SUPABASE_SERVICE_ROLE");

      if(!supabaseUrl || !anonKey || !serviceKey){
        return json({ error: "SERVER_MISCONFIG", hint: "Faltan variables Supabase en Functions/Edge." }, 500);
      }

      const u = await getSupabaseUserId(req, supabaseUrl, anonKey);
      if(!u.ok){
        return json({
          error: "NEED_LOGIN",
          message: "Tu sesión no es válida. Cierra sesión, borra datos del sitio y vuelve a iniciar."
        }, u.status || 401);
      }

      const pro = await isProUser(u.userId, supabaseUrl, serviceKey);
      if(!pro){
        return json({
          error: "PRO_REQUIRED",
          message: "Esta función de IA está disponible solo para cuentas PRO.",
          upgrade: true
        }, 402);
      }
    }

    const apiKey = getEnv("OPENAI_API_KEY");
    if(!apiKey){
      return new Response("Missing OPENAI_API_KEY env var", { status: 500 });
    }

    const model = String(getEnv("OPENAI_MODEL") || "gpt-5.2");

    const prompt = buildPrompt(task, payload);
    if(!prompt){
      return json({ error: "Unknown task" }, 400);
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        instructions: prompt.instructions,
        input: prompt.input
      })
    });

    const jsonResp = await r.json().catch(()=> ({}));
    if(!r.ok){
      return json({ error: "OPENAI_ERROR", details: jsonResp }, r.status || 500);
    }

    let outText = "";
    // Responses API: prefer output_text if present
    if(typeof jsonResp.output_text === "string") outText = jsonResp.output_text;

    // Fallback: walk output content
    if(!outText && Array.isArray(jsonResp.output)){
      for(const item of jsonResp.output){
        for(const part of (item?.content || [])){
          if(part?.type === "output_text") outText += (part.text || "");
          if(part?.type === "text") outText += (part.text || "");
        }
      }
    }

    let data = null;
    try{ data = JSON.parse(outText); }catch(_){}

    const result = data ?? { text: outText };
    return json(result, 200);

  }catch(err){
    return new Response(err?.message || "AI error", { status: 500 });
  }
};



function buildPrompt(task, payload){
  const baseRules = `
Eres un tutor de inglés extremadamente claro y práctico.
Responde SIEMPRE en JSON válido y nada más (sin markdown, sin texto extra).
No inventes etimologías raras. Si dudas, sé honesto dentro del JSON.
`;

  if(task === "ping"){
    return { instructions: baseRules, input: `Devuelve {"pong":"IA lista"}.` };
  }

  if(task === "word_info"){
    const word = String(payload?.word || "").trim();
    const context = String(payload?.context || "").trim().slice(0, 1200);
    return {
      instructions: baseRules,
      input: `
Analiza la palabra: "${word}"
Contexto (si sirve):
<<CONTEXT>>
${context}
<<END_CONTEXT>>

Devuelve EXACTO este esquema:
{
  "word_info":{
    "word":"${word}",
    "translation":"...",
    "meaning":"...",
    "ipa":"...",
    "pronunciation_hint":"...",
    "example_formal":"...",
    "example_casual":"...",
    "synonyms":["..."],
    "warnings":["..."]
  }
}
Reglas:
- translation en español (México neutral).
- meaning: significado corto y real (1-2 frases).
- pronunciation_hint: guía fonética simple para hispanohablante.
- examples: 1 línea cada uno.
- synonyms: 3-6.
- warnings: 0-3 (falsos amigos, registro, etc).
`
    };
  }

  if(task === "daily_words"){
    const topic = String(payload?.topic || "daily");
    const n = Math.max(5, Math.min(15, Number(payload?.n || 10)));
    return {
      instructions: baseRules,
      input: `
Genera ${n} palabras en inglés para el tema "${topic}".
Devuelve EXACTO:
{
  "words":[
    {"word":"...","translation":"...","ipa":"...","pronunciation_hint":"...","example":"..."}
  ]
}
Reglas:
- Palabras útiles (no raras), mezcla sustantivos/verbos/adjetivos.
- example en inglés, corto y natural.
- translation en español.
`
    };
  }

  if(task === "quiz_word"){
    const wi = payload?.word_info || {};
    const w = String(wi?.word || "").trim();
    const tr = String(wi?.translation || "").trim();
    return {
      instructions: baseRules,
      input: `
Crea un mini-quiz de opción múltiple para la palabra "${w}" (traducción: "${tr}").
Devuelve:
{
  "quiz":{
    "question":"...",
    "choices":["...","...","...","..."],
    "correct_index":0,
    "explanation":"..."
  }
}
Reglas:
- question en español.
- choices en español.
- Solo 1 correcta.
- explanation breve, con tip práctico.
`
    };
  }

  if(task === "summarize"){
    const text = String(payload?.text || "").slice(0, 6000);
    return {
      instructions: baseRules,
      input: `
Resume este texto en español (máximo 6 bullets):
<<TEXT>>
${text}
<<END_TEXT>>

Devuelve {"summary":"..."} (summary con bullets usando \\n- ).
`
    };
  }

  if(task === "ask"){
    const q = String(payload?.question || "");
    const ctx = String(payload?.context || "").slice(0, 1500);
    return {
      instructions: baseRules,
      input: `
Pregunta del usuario: "${q}"
Contexto:
<<CTX>>
${ctx}
<<END_CTX>>

Devuelve {"answer":"..."}.
Responde en español, ultra claro, con ejemplo breve si ayuda.
`
    };
  }

  if(task === "explain_sentence"){
    const s = String(payload?.sentence || "");
    const ctx = String(payload?.context || "").slice(0, 1500);
    return {
      instructions: baseRules,
      input: `
Explica esta oración en inglés para un hispanohablante:
"${s}"
Contexto:
<<CTX>>
${ctx}
<<END_CTX>>

Devuelve:
{"explanation":"..."}
Incluye: significado, 1-2 puntos gramaticales, y 1 reescritura más simple.
`
    };
  }

  return null;
}
