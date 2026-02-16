const formidable = require("formidable");

exports.handler = async (event)=> {
  try{
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if(!OPENAI_API_KEY) return json(500,{error:"Missing OPENAI_API_KEY"});

    // Debe ser multipart/form-data
    const ct = (event.headers["content-type"] || event.headers["Content-Type"] || "");
    if(!ct.includes("multipart/form-data")){
      return json(400,{error:`Content-Type must be multipart/form-data. Got: ${ct}`});
    }

    const form = formidable({
      multiples:false,
      maxFileSize: 25 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve,reject)=>{
      form.parse(event, (err, fields, files)=>{
        if(err) reject(err);
        else resolve({ fields, files });
      });
    });

    const f = files.file;
    if(!f) return json(400,{error:"Missing file field"});
    const file = Array.isArray(f) ? f[0] : f;

    // Leer buffer (formidable guarda en filepath)
    const fs = require("fs");
    const buf = fs.readFileSync(file.filepath);
    const mimeType = fields.mimeType || file.mimetype || "audio/webm";

    // Node 18 tiene FormData y Blob
    const fd = new FormData();
    fd.append("model","whisper-1");
    fd.append("file", new Blob([buf], { type: mimeType }), "audio.webm");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:"POST",
      headers:{ "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: fd
    });

    const txt = await r.text();
    let j;
    try{ j = JSON.parse(txt); }catch{ j = { raw: txt }; }

    if(!r.ok){
      return json(500,{error:"STT failed", details:j});
    }

    return json(200,{ text: (j.text||"").trim() });

  }catch(e){
    return json(500,{error:String(e && e.message ? e.message : e)});
  }
};

function json(statusCode, obj){
  return {
    statusCode,
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(obj)
  };
}



