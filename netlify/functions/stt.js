// netlify/functions/stt.js
export default async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), { status: 500 });

    const form = await req.formData();
    const file = form.get("file");
    if (!file) return new Response(JSON.stringify({ error: "No audio file" }), { status: 400 });

    const fd = new FormData();
    fd.append("file", file, "audio.webm");
    fd.append("model", "gpt-4o-mini-transcribe");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });

    const data = await r.json();
    if (!r.ok) return new Response(JSON.stringify({ error: data }), { status: 500 });

    return new Response(JSON.stringify({ text: data.text || "" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
};
