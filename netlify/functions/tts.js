exports.handler = async (event)=> {
  try{
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if(!OPENAI_API_KEY) return json(500,{error:"Missing OPENAI_API_KEY"});

    const body = JSON.parse(event.body || "{}");
    const text = (body.text || "").trim();
    if(!text) return json(400,{error:"Missing text"});

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "tts-1",
        voice: process.env.OPENAI_TTS_VOICE || "alloy",
        format: "mp3",
        input: text
      })
    });

    if(!r.ok){
      const txt = await r.text();
      return json(500,{error:"TTS failed", details:txt.slice(0,300)});
    }

    const buf = Buffer.from(await r.arrayBuffer());
    return {
      statusCode: 200,
      headers: {
        "Content-Type":"audio/mpeg",
        "Cache-Control":"no-store"
      },
      body: buf.toString("base64"),
      isBase64Encoded: true
    };

  }catch(e){
    return json(500,{error:String(e && e.message ? e.message : e)});
  }
};

function json(statusCode, obj){
  return { statusCode, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) };
}



