// netlify/functions/stt.js
import OpenAI from "openai";
import { formidable } from "formidable";
import fs from "fs";

function resp(statusCode, obj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      ...extraHeaders
    },
    body: JSON.stringify(obj)
  };
}

export async function handler(event) {
  try {
    // Preflight CORS
    if (event.httpMethod === "OPTIONS") {
      return resp(204, {});
    }

    if (event.httpMethod !== "POST") {
      return resp(405, { error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return resp(500, { error: "Missing OPENAI_API_KEY in Netlify env vars" });
    }

    // Netlify entrega body como string; si es base64, decodificar
    const raw = event.body || "";
    const buf = Buffer.from(raw, event.isBase64Encoded ? "base64" : "utf8");

    // Simular req para formidable usando Readable stream
    const { Readable } = await import("stream");
    const req = new Readable();
    req.push(buf);
    req.push(null);

    // Headers IMPORTANTES para formidable (boundary viene aquí)
    req.headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
      req.headers[k.toLowerCase()] = v;
    }

    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 25 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    const fileObj = files.file;
    const f = Array.isArray(fileObj) ? fileObj[0] : fileObj;

    if (!f) {
      return resp(400, { error: "Missing file field 'file' in multipart form" });
    }

    const filepath = f.filepath || f.path;
    if (!filepath || !fs.existsSync(filepath)) {
      return resp(400, { error: "Uploaded file path missing or not found" });
    }

    // Transcripción
    const client = new OpenAI({ apiKey });

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(filepath),
      model: "gpt-4o-mini-transcribe"
    });

    return resp(200, { text: (result?.text || "").trim() });
  } catch (e) {
    console.error("STT ERROR:", e);
    return resp(500, { error: String(e?.message || e) });
  }
}





