// netlify/functions/chat.js
// CJS handler (compatible with Netlify Functions runtime)
const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(obj),
});

exports.handler = async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();

    // Warm-up / keep-alive
    if (method === "GET") return json(200, { ok: true });

    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
        body: "",
      };
    }

    if (method !== "POST") return json(405, { error: "Method not allowed" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const body = JSON.parse(event.body || "{}");
    const userText = String(body?.userText || "").trim();
    const mode = body?.mode || "coach";

    // Acepta history o memory
    const memory = Array.isArray(body?.history)
      ? body.history
      : (Array.isArray(body?.memory) ? body.memory : []);

    if (!userText) return json(400, { error: "Missing userText" });

    const systemByMode = {
      call:
        "You are an English coach in a voice call. Maintain conversational context across turns. " +
        "The user may speak Spanish OR English. If the user asks in Spanish how to say something in English, respond with:\n" +
        "1) A natural English sentence (1–2 options)\n" +
        "2) Simple pronunciation (phonetics)\n" +
        "3) A brief Spanish explanation.\n" +
        "If the user speaks English, correct them (grammar + naturalness) and give an improved version. " +
        "Keep responses fast: max 3 short lines.",
      coach:
        "You are an English coach. The user may write in Spanish or English. " +
        "If Spanish: provide the English sentence + brief explanation. " +
        "If English: correct mistakes and provide an improved sentence. Be concise, practical, and friendly.",
      friendly:
        "You are a friendly English partner. Keep it short, helpful, and encouraging.",
      strict:
        "You are a strict English teacher. Correct mistakes clearly and provide brief guidance.",
    };

    const sys = systemByMode[mode] || systemByMode.coach;

    const messages = [
      { role: "system", content: sys },
      ...(Array.isArray(memory) ? memory : []),
      { role: "user", content: userText },
    ];

    const max_tokens =
      mode === "call" ? 90 :
      mode === "friendly" ? 140 :
      mode === "strict" ? 180 : 180;

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

    if (!resp.ok) {
      const t = await resp.text();
      return json(resp.status, { error: t });
    }

    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || "";

    const newMemory = [...messages.filter(m => m.role !== "system"), { role: "assistant", content: reply }].slice(-14);

    return json(200, { reply, memory: newMemory });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
};
