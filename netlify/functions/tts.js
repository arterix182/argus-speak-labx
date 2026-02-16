// netlify/functions/tts.js
import { Buffer } from "node:buffer";

export async function handler(event) {
  try {
    if ((event.httpMethod || "POST").toUpperCase() !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const body = safeJson(event.body);
    const text = String(body?.text || "").trim();
    if (!text) return json(400, { error: "Missing text" });

    // Recomendación para “voz mujer muy real”:
    // - Modelo: tts-1-hd (calidad) o gpt-4o-mini-tts (más control de estilo)
    // - Voz: shimmer o nova (suelen percibirse femeninas; depende del oído)
    const model = body?.model || "tts-1-hd";   // ✅ más rápido
    const voice = body?.voice || "nova";    // ✅ voz NOVA
    const format = body?.format || "mp3";     // mp3, wav, aac, opus...
    const speed = typeof body?.speed === "number" ? body.speed : 1.0;

    // Con gpt-4o-mini-tts puedes dar “instrucciones” de estilo.
    // No aplica a tts-1 / tts-1-hd según docs. :contentReference[oaicite:3]{index=3}
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
      return json(r.status, { error: `OpenAI TTS ${r.status}: ${errTxt}` });
    }

    // Devuelve bytes de audio
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


