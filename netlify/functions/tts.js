export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const { text } = await req.json();
    if (!text) return new Response(JSON.stringify({ error: "Missing text" }), { status: 400 });

    const apiKey = process.env.OPENAI_API_KEY;

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return new Response(JSON.stringify({ error: err }), { status: 500 });
    }

    // Regresar audio directamente
    const audioBuf = await r.arrayBuffer();
    return new Response(audioBuf, {
      headers: { "Content-Type": "audio/mpeg" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
};


