export async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();

    // ✅ Warm-up / keep-alive (NO llama a OpenAI)
    if (method === "GET") {
      return json(200, { ok: true });
    }

    if (method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const body = JSON.parse(event.body || "{}");

    // Acepta history o memory (frontend manda history)
    const userText = String(body?.userText || "").trim();
    const mode = body?.mode || "coach";
    const memory = Array.isArray(body?.history) ? body.history
                 : (Array.isArray(body?.memory) ? body.memory : []);

    if (!userText) return json(400, { error: "Missing userText" });

    const systemByMode = {
      // ✅ Modo llamada: ultra-rápido + mantiene el hilo de la conversación
      // Nota: "pronunciación" no puede medirse perfecto sólo con texto; damos tips basados en palabras difíciles.
      call:   "You are an English coach in a voice call. Maintain conversation context across turns. Be VERY concise: (1) Correct the user's English in ONE sentence. (2) Give ONE improved version. (3) If helpful, add ONE pronunciation tip for 1-2 hard words (simple phonetics/IPA). Keep everything under 2 short sentences total.",
      coach:  "You are an English coach. Be concise. Correct the user's English, then give 1-2 short examples, and a quick question. Reply in Spanish if helpful, but keep examples in English.",
      friendly:"You are a friendly English partner. Keep it short, helpful, and encouraging.",
      strict: "You are a strict English teacher. Correct mistakes clearly and provide brief guidance.",
    };

    const sys = systemByMode[mode] || systemByMode.coach;

    const messages = [
      { role: "system", content: sys },
      ...(Array.isArray(memory) ? memory : []),
      { role: "user", content: userText }
    ];

    // ✅ Limita longitud para velocidad (especialmente en modo call)
    const max_tokens =
      mode === "call" ? 90 :
      mode === "friendly" ? 140 :
      mode === "strict" ? 180 :
      180;

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages,
        temperature: 0.4,
        max_tokens,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return json(resp.status, data);

    const reply = data.choices?.[0]?.message?.content?.trim() || "";

    // Guarda memoria sin el system (últimos 14)
    const newMemory = [...messages.filter(m => m.role !== "system"), { role: "assistant", content: reply }].slice(-14);

    return json(200, { reply, memory: newMemory });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}






