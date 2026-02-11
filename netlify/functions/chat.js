// netlify/functions/chat.js
// Chat con memoria corta + modos (coach / interview / work / casual)
// Espera JSON: { userText, history?: [{role,content}], mode?: string }
// Responde JSON: { reply }

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json(500, { error: "Missing OPENAI_API_KEY" });

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON" });
    }

    const userText = (body.userText || "").toString().trim();
    if (!userText) return json(400, { error: "Missing userText" });

    const mode = (body.mode || "coach").toString().toLowerCase();
    const rawHistory = Array.isArray(body.history) ? body.history : [];

    // Normaliza history y limita a 6 turnos (12 mensajes user/assistant)
    const history = rawHistory
      .filter(m => m && typeof m === "object")
      .map(m => ({
        role: (m.role === "user" || m.role === "assistant") ? m.role : "user",
        content: (m.content || "").toString().slice(0, 1200)
      }))
      .filter(m => m.content.trim().length > 0)
      .slice(-12);

    const system = buildSystemPrompt(mode);

    // Construye mensajes
    const messages = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText }
    ];

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.6,
        max_tokens: 220
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return json(500, { error: `OpenAI error (${resp.status})`, detail: safeTrim(text, 1200) });
    }

    const data = await resp.json();
    const reply = (data?.choices?.[0]?.message?.content || "").toString().trim();

    if (!reply) return json(500, { error: "Empty reply" });
    return json(200, { reply });

  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
}

function buildSystemPrompt(mode) {
  // Reglas para que suene premium en voz:
  // - corto, claro, humano
  // - corrige 1-2 cosas máximo
  // - siempre: Corrección + 1 ejemplo + 1 pregunta corta
  const base = `
Eres "ARGUS SPEAK LAB-X", un coach de inglés por voz.
Responde SIEMPRE en español (pero ejemplos en inglés).
Estilo: directo, motivador, profesional, humano.
Formato preferido (muy importante):
1) "Correction:" (una oración corregida en inglés)
2) "Example:" (otro ejemplo breve en inglés)
3) "Quick question:" (pregunta corta para continuar)
Reglas:
- Corrige máximo 2 errores.
- No hagas textos largos. 2–6 líneas.
- Si el usuario dice una palabra suelta, pregunta qué quiso decir.
- Evita sermones. Ve al grano.
`.trim();

  const modes = {
    coach: `
Modo COACH:
- Enfócate en mejorar claridad y gramática con tacto.
- Da una mini sugerencia adicional (1 tip máximo).
`.trim(),
    interview: `
Modo INTERVIEW:
- Haz preguntas tipo entrevista laboral.
- Corrige y luego pregunta algo más retador.
`.trim(),
    work: `
Modo WORK ENGLISH:
- Prioriza vocabulario de trabajo, juntas, correos, fábrica/ingeniería.
- Mantén ejemplos “work-like”.
`.trim(),
    casual: `
Modo CASUAL:
- Conversación natural, ligera.
- Corrige suave y sigue el tema.
`.trim()
  };

  return `${base}\n\n${modes[mode] || modes.coach}`;
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(obj)
  };
}

function safeTrim(s, n) {
  const t = (s || "").toString();
  return t.length > n ? t.slice(0, n) + "…" : t;
}






