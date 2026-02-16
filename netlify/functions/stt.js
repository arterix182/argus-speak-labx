// netlify/functions/stt.js
// STT endpoint: recibe audio (multipart/form-data o JSON base64) y lo manda a OpenAI.
// Hecho para Netlify Functions + ESM ("type":"module").
// FIX: detecta correctamente body utf8 vs base64 usando el boundary real.

import { Buffer } from "node:buffer";

export const config = {
  api: { bodyParser: false },
};

export async function handler(event) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const method = (event.httpMethod || "POST").toUpperCase();
    if (method !== "POST") return json(405, { error: "Method not allowed" });

    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();

    // ---------- A) multipart/form-data ----------
    if (ct.includes("multipart/form-data")) {
      const boundary = getBoundary(ct);
      if (!boundary) return json(400, { error: "Missing multipart boundary" });

      const rawBody = getRawBodyBufferByBoundary(event, boundary);
      const parts = parseMultipart(rawBody, boundary);

      // Esperamos: file (binario) y opcional: mimeType (texto)
      const filePart = parts.find(p => p.name === "file") || parts.find(p => p.filename);
      if (!filePart || !filePart.data || filePart.data.length === 0) {
        return json(400, { error: "Missing file field or empty file" });
      }

      const mimePart = parts.find(p => p.name === "mimeType");
      const mimeType =
        (mimePart?.data ? mimePart.data.toString("utf8").trim() : "") ||
        filePart.contentType ||
        "audio/webm";

      const filename = filePart.filename || "audio.webm";

      const text = await transcribeWithOpenAI({
        key,
        audioBuf: filePart.data,
        mimeType,
        filename,
      });

      return json(200, { text });
    }

    // ---------- B) JSON base64 ----------
    if (ct.includes("application/json")) {
      const body = JSON.parse(event.body || "{}");
      const audioBase64 = body.audioBase64;
      const mimeType = body.mimeType || "audio/webm";
      const filename = body.filename || "audio.webm";

      if (!audioBase64) return json(400, { error: "Missing audioBase64" });

      const audioBuf = Buffer.from(audioBase64, "base64");
      if (!audioBuf || audioBuf.length === 0) return json(400, { error: "Empty audioBase64 buffer" });

      const text = await transcribeWithOpenAI({ key, audioBuf, mimeType, filename });
      return json(200, { text });
    }

    return json(400, {
      error: "Unsupported Content-Type. Use multipart/form-data or application/json.",
      contentType: ct || "(missing)",
    });
  } catch (e) {
    return json(500, {
      error: e?.message || String(e),
      stack: e?.stack ? String(e.stack).split("\n").slice(0, 8).join("\n") : undefined,
    });
  }
}

// ---------------- OpenAI call ----------------
async function transcribeWithOpenAI({ key, audioBuf, mimeType, filename }) {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([audioBuf], { type: mimeType }), filename);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  const txt = await r.text();
  let data = {};
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }

  if (!r.ok) {
    const msg = data?.error?.message || data?.error || data?.message || txt || ("HTTP " + r.status);
    throw new Error(`OpenAI STT ${r.status}: ${msg}`);
  }

  return String(data.text || "").trim();
}

// ---------------- multipart helpers ----------------
function getBoundary(contentType) {
  const m = contentType.match(/boundary=([^;]+)/i);
  if (!m) return "";
  return m[1].trim().replace(/^"|"$/g, "");
}

// ✅ Elige el buffer correcto comparando contra el boundary REAL
function getRawBodyBufferByBoundary(event, boundary) {
  const bodyStr = event.body || "";
  if (!bodyStr) return Buffer.alloc(0);

  const marker = `--${boundary}`;

  // Candidato 1: utf8 directo
  const bufUtf8 = Buffer.from(bodyStr, "utf8");
  if (bufUtf8.toString("latin1").includes(marker)) return bufUtf8;

  // Candidato 2: base64 (aunque isBase64Encoded venga mal)
  // Intentamos siempre; si no era base64, no contendrá el boundary.
  try {
    const bufB64 = Buffer.from(bodyStr, "base64");
    if (bufB64.toString("latin1").includes(marker)) return bufB64;
  } catch {}

  // Si Netlify sí marcó base64, respétalo
  if (event.isBase64Encoded) {
    try { return Buffer.from(bodyStr, "base64"); } catch {}
  }

  // Último fallback
  return bufUtf8;
}

function parseMultipart(buf, boundary) {
  // Cortamos como latin1 para no corromper bytes (1:1)
  const body = buf.toString("latin1");
  const delim = `--${boundary}`;
  const sections = body.split(delim);

  const usable = sections.slice(1, -1);
  const parts = [];

  for (let sec of usable) {
    sec = sec.replace(/^\r\n/, "");
    sec = sec.replace(/\r\n$/, "");

    const idx = sec.indexOf("\r\n\r\n");
    if (idx === -1) continue;

    const rawHeaders = sec.slice(0, idx);
    let rawData = sec.slice(idx + 4);

    if (rawData.endsWith("\r\n")) rawData = rawData.slice(0, -2);

    const headers = {};
    for (const line of rawHeaders.split("\r\n")) {
      const j = line.indexOf(":");
      if (j === -1) continue;
      const k = line.slice(0, j).trim().toLowerCase();
      const v = line.slice(j + 1).trim();
      headers[k] = v;
    }

    const disp = headers["content-disposition"] || "";
    const name = getDispParam(disp, "name");
    const filename = getDispParam(disp, "filename");
    const contentType = headers["content-type"];

    const data = Buffer.from(rawData, "latin1");
    parts.push({ name, filename, contentType, data });
  }

  return parts;
}

function getDispParam(contentDisposition, key) {
  const re = new RegExp(`${key}=("([^"]*)"|[^;]+)`, "i");
  const m = contentDisposition.match(re);
  if (!m) return "";
  const v = m[2] || m[1] || "";
  return v.replace(/^"|"$/g, "");
}

// ---------------- response helper ----------------
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
