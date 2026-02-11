const FormData = require("form-data");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };

    const { audioBase64, mimeType } = JSON.parse(event.body || "{}");
    if (!audioBase64) return { statusCode: 400, body: JSON.stringify({ error: "Missing audioBase64" }) };

    const buffer = Buffer.from(audioBase64, "base64");
    const fd = new FormData();
    fd.append("file", buffer, { filename: "audio.webm", contentType: mimeType || "audio/webm" });
    fd.append("model", "gpt-4o-mini-transcribe");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, ...fd.getHeaders() },
      body: fd,
    });

    const data = await r.json();
    if (!r.ok) return { statusCode: 500, body: JSON.stringify({ error: data }) };

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: data.text || "" }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};


