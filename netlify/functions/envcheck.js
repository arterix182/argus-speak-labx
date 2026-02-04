function b64urlDecode(str){
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}

function jwtRef(jwt){
  try{
    if(!jwt) return null;
    const payload = jwt.split(".")[1];
    const obj = JSON.parse(b64urlDecode(payload));
    return obj.ref || null; // para keys de Supabase (anon/service) normalmente viene "ref"
  }catch{
    return null;
  }
}

exports.handler = async () => {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const urlRef = url ? new URL(url).hostname.split(".")[0] : null;

  const anonRef = jwtRef(process.env.SUPABASE_ANON_KEY);
  const serviceRef = jwtRef(process.env.SUPABASE_SERVICE_ROLE);

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: process.env.CONTEXT || null,
      supabaseUrl: url || null,
      urlRef,
      anonRef,
      serviceRef,
      ok: !!urlRef && urlRef === anonRef && urlRef === serviceRef
    }, null, 2)
  };
};
