// netlify/functions/chat.js
export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), { status: 500 });

    const { userText } = await req.json();
    if (!userText) return new Response(JSON.stringify({ error: "Missing userText" }), { status: 400 });

    const messages = [
      { role: "system", content: "Eres un coach de inglés. Responde corto y útil. Corrige 1 cosa máximo y da 1 ejemplo." },
      { role: "user", content: userText }
    ];

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.6
      }),
    });

    const data = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ error: data }), { status: 500 });

    const reply = data.choices?.[0]?.message?.content?.trim() || "";
    return new Response(JSON.stringify({ reply }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
};
