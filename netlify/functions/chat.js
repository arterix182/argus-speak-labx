export async function handler(event) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const { userText, mode = "coach", memory = [] } = JSON.parse(event.body || "{}");
    if (!userText) return json(400, { error: "Missing userText" });

    const systemByMode = {
      coach: "You are an English coach. Be concise. Correct the user's English, then give 1-2 short examples, and a quick question. Reply in Spanish if helpful, but keep examples in English.",
      friendly: "You are a friendly English partner. Keep it short, helpful, and encouraging.",
      strict: "You are a strict English teacher. Correct mistakes clearly and provide brief guidance.",
    };

    const sys = systemByMode[mode] || systemByMode.coach;

    const messages = [
      { role: "system", content: sys },
      ...(Array.isArray(memory) ? memory : []),
      { role: "user", content: userText }
    ];

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
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return json(resp.status, data);

    const reply = data.choices?.[0]?.message?.content?.trim() || "";
    const newMemory = [...messages.filter(m => m.role !== "system"), { role: "assistant", content: reply }].slice(-14);

    return json(200, { reply, memory: newMemory });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}









