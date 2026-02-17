function b64urlDecode(str){
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64").toString("utf8");
}

exports.handler = async (event) => {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const expectedIssuer = supabaseUrl ? `${supabaseUrl}/auth/v1` : null;

  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  let tokenIss = null;
  try{
    const payload = JSON.parse(b64urlDecode(token.split(".")[1] || ""));
    tokenIss = payload.iss || null;
  }catch{}

  return {
    statusCode: 200,
    headers: { "content-type":"application/json" },
    body: JSON.stringify({
      expectedIssuer,
      tokenIss,
      match: !!expectedIssuer && !!tokenIss && expectedIssuer === tokenIss
    }, null, 2)
  };
};
