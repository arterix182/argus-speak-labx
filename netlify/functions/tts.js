// netlify/functions/tts.js
import { Buffer } from "node:buffer";

export async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();

    // ✅ Warm-up / keep-alive: evita cold start (NO llama a OpenAI)
    if (method === "GET") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({ ok: true }),
      };
    }

    if (method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const body = safeJson(event.body);
    const text = String(body?.text || "").trim();
    if (!text) return json(400, { error: "Missing text" });

    // ✅ Defaults optimizados para LATENCIA (respuesta rápida)
    // - tts-1 = más rápido (ideal para conversación)
    // - nova = voz femenina consistente
    // - speed 0.85 = más lento para aprender
    const model  = body?.model  || "tts-1";
    const voice  = body?.voice  || "nova";
    const format = body?.format || "mp3";
    const speed  = typeof body?.speed === "number" ? body.speed : 0.85;

    // Solo aplica si usas gpt-4o-mini-tts (tu código ya lo soporta)
    const instructions =
      body?.instructions ||
      "Warm, natural, very realistic female voice. Clear diction. Friendly and confident. No robotic tone.";

    const payload = {
      model,
      voice,
      input: text,
      response_format: format,
      speed,
      ...(model === "gpt-4o-mini-tts" ? { instructions } : {}),
    };

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      // ✅ más legible en consola
      return json(r.status, { error: `OpenAI TTS ${r.status}: ${errTxt}` });
    }

    const arrayBuf = await r.arrayBuffer();
    const buf = Buffer.from(arrayBuf);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": formatToMime(format),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
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

function formatToMime(fmt) {
  const f = String(fmt || "mp3").toLowerCase();
  if (f === "mp3") return "audio/mpeg";
  if (f === "wav") return "audio/wav";
  if (f === "aac") return "audio/aac";
  if (f === "opus") return "audio/opus";
  if (f === "flac") return "audio/flac";
  if (f === "pcm") return "application/octet-stream";
  return "audio/mpeg";
}


