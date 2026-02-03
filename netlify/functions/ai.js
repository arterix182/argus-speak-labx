// Netlify Function: /api/ai
// Keep OPENAI_API_KEY on the server (Environment Variables).
// Calls OpenAI Responses API: https://api.openai.com/v1/responses
//
// PRO Paywall:
// - Requires Supabase session (Authorization: Bearer <access_token>)
// - Requires active/trialing subscription in `profiles`

async function getSupabaseUser(req){
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if(!supabaseUrl || !anonKey) return { error:"Missing SUPABASE_URL / SUPABASE_ANON_KEY", status:500 };

  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if(!m) return { error:"Necesitas iniciar sesión (token).", status:401 };

  const token = m[1];
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { "apikey": anonKey, "Authorization": `Bearer ${token}` }
  });
  if(!r.ok) return { error:"Sesión inválida. Vuelve a entrar.", status:401 };
  const user = await r.json();
  return { user };
}

async function getProfileByUserId(userId){
  const supabaseUrl = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!supabaseUrl || !service) return null;

  const url = `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status,subscription_current_period_end`;
  const r = await fetch(url, {
    headers: { "apikey": service, "Authorization": `Bearer ${service}` }
  });
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

function isPro(profile){
  const st = (profile?.subscription_status || "").toLowerCase();
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
      return new Response(JSON.stringify({ pong: "OK" }), { status:200, headers:{ "Content-Type":"application/json" }});
    }

    // Auth + subscription check
    const s = await getSupabaseUser(req);
    if(s?.error) return new Response(s.error, { status: s.status || 401 });

    const profile = await getProfileByUserId(s.user.id);
    if(!isPro(profile)){
      return new Response("Suscripción PRO requerida para usar IA.", { status: 402 });
    }

    const key = process.env.OPENAI_API_KEY;
    if(!key){
      return new Response("Missing OPENAI_API_KEY env var", { status: 500 });
    }

    const model = process.env.OPENAI_MODEL || "gpt-5";
    const store = false;

    const prompts = buildPrompt(task, payload);
    if(!prompts){
      return new Response(JSON.stringify({ error: "Unknown task" }), { status: 400, headers: { "Content-Type":"application/json" } });
    }

    const body = {
      model,
      store,
      input: [
        { role:"system", content: prompts.instructions },
        { role:"user", content: prompts.input }
      ],
      // Ask for JSON when needed; individual tasks instruct strict JSON.
      text: { format: { type: "text" } }
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const json = await r.json().catch(()=> ({}));
    if(!r.ok){
      const msg = json?.error?.message || "OpenAI request failed";
      return new Response(msg, { status: 500 });
    }

    // Extract text
    let outText = "";
    const stripFences = (t) => {
      const s = String(t||"").trim();
      if(s.startsWith("```")){
        return s.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```\s*$/, "").trim();
      }
      return s;
    };
    try{
      // Newer Responses API can include output_text helper in some SDKs, but raw JSON varies.
      if(typeof json.output_text === "string") outText = json.output_text;
      else if(Array.isArray(json.output)){
        for(const item of json.output){
          const c = item?.content;
          if(Array.isArray(c)){
            for(const part of c){
              if(part?.type === "output_text") outText += (part.text || "");
              if(part?.type === "text") outText += (part.text || "");
            }
          }
        }
      }
    }catch(_){}

    // Try parse JSON if user asked for JSON
    let data = null;
    try{ data = JSON.parse(outText); }catch(_){}

    const result = data ?? { text: outText };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
    });
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
