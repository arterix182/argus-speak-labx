// netlify/functions/chat.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }) };
    }

    const { userText } = JSON.parse(event.body || "{}");
    if (!userText) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing userText" }) };
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Eres un coach de inglés. Responde corto y útil." },
          { role: "user", content: userText }
        ],
        temperature: 0.6
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: data }) };
    }

    const reply = data.choices?.[0]?.message?.content?.trim() || "";
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
};




