// netlify/functions/stt.js
import OpenAI from "openai";
import { formidable } from "formidable";   // ✅ esta es la forma correcta para formidable v3+
import fs from "fs";

export const config = {
  api: { bodyParser: false },
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(obj),
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // ✅ formidable necesita un request-like object. Netlify te pasa event, así que usamos workaround:
    // Creamos un stream temporal a partir del body base64.
    const isBase64 = event.isBase64Encoded;
    const bodyBuffer = Buffer.from(event.body || "", isBase64 ? "base64" : "utf8");

    // Simulamos req para formidable (Netlify no da req real)
    // formidable permite parsear si le pasas un objeto con headers y un stream readable.
    const { Readable } = await import("stream");
    const req = new Readable();
    req.push(bodyBuffer);
    req.push(null);
    req.headers = event.headers || {};

    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 25 * 1024 * 1024,
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    const fileObj = files.file;
    if (!fileObj) return json(400, { error: "Missing file" });

    // formidable a veces devuelve array
    const f = Array.isArray(fileObj) ? fileObj[0] : fileObj;

    const filepath = f.filepath || f.path; // depende versión
    if (!filepath) return json(400, { error: "No filepath from upload" });

    const mimeType = fields.mimeType || f.mimetype || "audio/webm";

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(filepath),
      model: "gpt-4o-mini-transcribe",
      // language: "en", // opcional
    });

    return json(200, { text: transcript.text || "", mimeType });
  } catch (e) {
    console.error("STT ERROR:", e);
    return json(500, { error: String(e?.message || e) });
  }
}




