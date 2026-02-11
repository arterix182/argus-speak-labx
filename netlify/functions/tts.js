exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };

    const { text } = JSON.parse(event.body || "{}");
    if (!text) return { statusCode: 400, body: JSON.stringify({ error: "Missing text" }) };

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: text
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return { statusCode: 500, body: JSON.stringify({ error: err }) };
    }

    const buf = await r.arrayBuffer();
    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg" },
      body: Buffer.from(buf).toString("base64"),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};

