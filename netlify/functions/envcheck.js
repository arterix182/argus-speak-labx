function keyType(v){
  if(!v) return "missing";
  if(v.startsWith("sb_")) return "sb";
  // JWT típico tiene 2 puntos (3 partes)
  if((v.match(/\./g) || []).length === 2) return "jwt";
  return "unknown";
}

exports.handler = async () => {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const urlRef = url ? new URL(url).hostname.split(".")[0] : null;

  const anon = process.env.SUPABASE_ANON_KEY || "";
  const service = process.env.SUPABASE_SERVICE_ROLE || "";

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      supabaseUrl: url || null,
      urlRef,
      anon_present: !!anon,
      anon_type: keyType(anon),
      anon_len: anon.length,
      service_present: !!service,
      service_type: keyType(service),
      service_len: service.length
    }, null, 2)
  };
};

