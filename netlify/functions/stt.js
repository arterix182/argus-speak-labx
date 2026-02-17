// netlify/functions/stt.js (RAW audio body -> OpenAI STT)
import { Buffer } from "node:buffer";

export const config = { api: { bodyParser: false } };

export async function handler(event) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    if ((event.httpMethod || "POST").toUpperCase() !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // Netlify a veces manda el body base64 aunque isBase64Encoded venga raro.
    // Heurística: si viene marcado base64, úsalo; si no, intenta base64 y cae a utf8.
    const bodyStr = event.body || "";
    if (!bodyStr) return json(400, { error: "Empty body" });

    let audioBuf = null;

    if (event.isBase64Encoded) {
      audioBuf = Buffer.from(bodyStr, "base64");
    } else {
      // Intento base64 primero (si no era, saldrá basura o muy pequeño)
      const b64 = Buffer.from(bodyStr, "base64");
      if (b64 && b64.length > 50) audioBuf = b64;
      else audioBuf = Buffer.from(bodyStr, "utf8");
    }

    if (!audioBuf || audioBuf.length < 50) {
      return json(400, { error: "Empty audio body" });
    }

    const mimeType =
      event.headers["x-mimetype"] ||
      event.headers["X-MimeType"] ||
      event.headers["content-type"] ||
      "audio/webm";

    const filename =
      event.headers["x-filename"] ||
      event.headers["X-Filename"] ||
      "audio.webm";

    const text = await transcribeWithOpenAI({ key, audioBuf, mimeType, filename });
    return json(200, { text });
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
}

async function transcribeWithOpenAI({ key, audioBuf, mimeType, filename }) {
  // 🔥 Para velocidad: intenta primero gpt-4o-mini-transcribe (si tu cuenta lo tiene)
  // y cae a whisper-1 como plan B.
  // Docs: /v1/audio/transcriptions soporta gpt-4o-mini-transcribe y gpt-4o-transcribe además de whisper-1.
  const preferredModels = [
    process.env.OPENAI_STT_MODEL, // si lo defines en Netlify
    "gpt-4o-mini-transcribe",
    "gpt-4o-transcribe",
    "whisper-1",
  ].filter(Boolean);

  let lastErr = null;

  for (const model of preferredModels) {
    try {
      const form = new FormData();
      form.append("model", model);
      form.append("file", new Blob([audioBuf], { type: mimeType }), filename);

      // Opcional: VAD del servidor (útil si mandas audio largo). Solo para modelos gpt-4o-*.
      if (String(model).startsWith("gpt-4o")) {
        form.append("chunking", "auto");
      }

      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });

      const txt = await r.text();
      let j = {};
      try { j = txt ? JSON.parse(txt) : {}; } catch { j = { error: txt }; }

      if (!r.ok) {
        const msg = j?.error?.message || j?.error || j?.message || txt || ("HTTP " + r.status);
        throw new Error(`model=${model} -> ${r.status}: ${msg}`);
      }

      return String(j.text || "").trim();
    } catch (e) {
      lastErr = e;
      // sigue al siguiente modelo
    }
  }

  throw new Error(`OpenAI STT failed: ${lastErr?.message || String(lastErr)}`);
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
