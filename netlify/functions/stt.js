// netlify/functions/stt.js (RAW audio body -> OpenAI STT)
// CJS handler compatible with Netlify Functions runtime.
const { Buffer } = require("node:buffer");

const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  },
  body: JSON.stringify(obj),
});

exports.handler = async function handler(event) {
  try {
    const method = (event.httpMethod || "GET").toUpperCase();

    // Warm-up / keep-alive (no OpenAI)
    if (method === "GET") return json(200, { ok: true });

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

    if (method !== "POST") return json(405, { error: "Method not allowed" });

    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    // Body is base64 (Netlify)
    const contentType = event.headers?.["content-type"] || event.headers?.["Content-Type"] || "application/octet-stream";
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "", "utf8");

    // Model preference
    const preferred = process.env.OPENAI_STT_MODEL;
    const tryModels = [preferred, "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"].filter(Boolean);

    // OpenAI STT expects multipart/form-data
    for (const model of tryModels) {
      const boundary = "----argusFormBoundary" + Math.random().toString(16).slice(2);
      const CRLF = "\r\n";

      const pre =
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
        `${model}${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
        `json${CRLF}` +
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="audio.webm"${CRLF}` +
        `Content-Type: ${contentType}${CRLF}${CRLF}`;

      const post =
        `${CRLF}--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="language"${CRLF}${CRLF}` +
        `en${CRLF}` +
        `--${boundary}--${CRLF}`;

      const bodyBuf = Buffer.concat([Buffer.from(pre, "utf8"), raw, Buffer.from(post, "utf8")]);

      const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: bodyBuf,
      });

      if (!resp.ok) {
        // try next model
        continue;
      }

      const data = await resp.json();
      const text = String(data?.text || "").trim();
      return json(200, { text, model });
    }

    return json(502, { error: "STT failed for all models" });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
};
