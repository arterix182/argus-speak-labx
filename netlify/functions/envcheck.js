exports.handler = async () => {
  const url = process.env.SUPABASE_URL || null;
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      supabaseUrl: url,
      ref: url ? new URL(url).hostname.split(".")[0] : null,
      hasAnon: !!process.env.SUPABASE_ANON_KEY,
      hasService: !!process.env.SUPABASE_SERVICE_ROLE,
      context: process.env.CONTEXT || null
    }, null, 2)
  };
};
