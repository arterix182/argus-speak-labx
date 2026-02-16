// NOTE:
// En algunos runtimes/bundlers (Netlify + mezcla ESM/CJS), `import formidable from "formidable"`
// termina como `import_formidable.default` y NO es una función.
// Para evitar el error:
//   (0, import_formidable.default) is not a function
// usamos la API estable IncomingForm.
import { IncomingForm } from "formidable";

export const config = {
  api: { bodyParser: false },
};

export async function handler(event) {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return json(500, { error: "Missing OPENAI_API_KEY" });

    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();

    // A) multipart/form-data
    if (ct.includes("multipart/form-data")) {
      const form = new IncomingForm({ multiples: false });
      const { files } = await new Promise((resolve, reject) => {
        form.parse(toNodeReq(event), (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      const file = files?.file;
      if (!file) return json(400, { error: "Missing file field" });

      const fs = await import("fs");
      const f = Array.isArray(file) ? file[0] : file;
      const buf = fs.readFileSync(f.filepath);

      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}` },
        body: buildMultipart(buf, f.mimetype || "audio/webm"),
      });

      const data = await r.json();
      if (!r.ok) return json(r.status, data);
      return json(200, { text: data.text || "" });
    }

    // B) JSON base64
    if (ct.includes("application/json")) {
      const body = JSON.parse(event.body || "{}");
      const audioBase64 = body.audioBase64;
      const mimeType = body.mimeType || "audio/webm";
      if (!audioBase64) return json(400, { error: "Missing audioBase64" });

      const buf = Buffer.from(audioBase64, "base64");

      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}` },
        body: buildMultipart(buf, mimeType),
      });

      const data = await r.json();
      if (!r.ok) return json(r.status, data);
      return json(200, { text: data.text || "" });
    }

    return json(400, { error: 'Unsupported Content-Type. Use multipart/form-data or application/json.' });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(obj),
  };
}

// ---- helpers ----

// formidable necesita un "req" Node-like.
// Netlify no te da req real aquí, así que hacemos un adaptador mínimo.
function toNodeReq(event) {
  const { Readable } = require("stream");
  const req = new Readable();
  req.push(event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8") : null);
  req.push(null);
  req.headers = event.headers;
  req.method = event.httpMethod || "POST";
  return req;
}

function buildMultipart(audioBuf, mimeType) {
  const boundary = "----VXBoundary" + Math.random().toString(16).slice(2);

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;

  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(head, "utf8"),
    Buffer.from(audioBuf),
    Buffer.from(tail, "utf8"),
  ]);

  return new Blob([body], { type: `multipart/form-data; boundary=${boundary}` });
}



