// netlify/functions/tts.js (Text -> audio bytes)
// CJS handler compatible with Netlify Functions runtime.
const { Buffer } = require("node:buffer");

exports.handler = async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();

    if (method === "GET") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
        body: JSON.stringify({ ok: true }),
      };
    }

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

    if (method !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const text = String(body?.text || "").trim();
    const voice = body?.voice || "alloy";

    if (!text) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Missing text" }),
      };
    }

    const resp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        format: "mp3",
        input: text,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: t }),
      };
    }

    const arr = new Uint8Array(await resp.arrayBuffer());
    const b64 = Buffer.from(arr).toString("base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ audioBase64: b64 }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
};
