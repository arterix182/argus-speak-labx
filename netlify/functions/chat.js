exports.handler = async (event)=> {
  try{
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if(!OPENAI_API_KEY) return json(500,{error:"Missing OPENAI_API_KEY"});

    const body = JSON.parse(event.body || "{}");
    const userText = (body.userText || "").trim();
    const mode = (body.mode || "coach").trim();
    if(!userText) return json(400,{error:"Missing userText"});

    const system = buildSystem(mode);

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role:"system", content: system },
          { role:"user", content: userText }
        ]
      })
    });

    const j = await r.json().catch(()=>({}));
    if(!r.ok){
      return json(500,{error:"CHAT failed", details:j});
    }
    const reply = j.choices?.[0]?.message?.content || "";
    return json(200,{ reply });

  }catch(e){
    return json(500,{error:String(e && e.message ? e.message : e)});
  }
};

function buildSystem(mode){
  if(mode==="teacher"){
    return "You are an English teacher. Correct the user briefly, then give 2 examples, then ask 1 quick question. Keep it concise.";
  }
  if(mode==="friend"){
    return "You are a friendly bilingual English buddy. Reply in English, but give short Spanish hints when needed. Keep it natural.";
  }
  return "You are a strict but motivating English coach. Correct the user, explain the mistake simply, give examples, and propose a better sentence. Keep it short.";
}

function json(statusCode, obj){
  return { statusCode, headers:{ "Content-Type":"application/json" }, body: JSON.stringify(obj) };
}








