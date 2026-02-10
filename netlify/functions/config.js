// Netlify Function: /api/config
// Exposes only "safe" public config (Supabase anon key is OK to expose).
// IMPORTANT: Netlify Functions run in Node (CommonJS). Do NOT use `export` here.

async function handler(req){
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  const appName = process.env.APP_NAME || "ARGUS SPEAK LAB-X";

  // Public URL of the app (safe to expose). Used for auth redirects and Stripe returns.
  const publicAppUrl = (process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  return new Response(
    JSON.stringify({ supabaseUrl, supabaseAnonKey, appName, publicAppUrl }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

// Netlify Node Function wrapper: adapts Netlify event/context to Fetch API Request/Response
exports.handler = async (event) => {
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host  = (event.headers && (event.headers.host || event.headers.Host)) || "localhost";
  const qs = event.rawQuery ? `?${event.rawQuery}` : "";
  const url = `${proto}://${host}${event.path || ""}${qs}`;

  const init = {
    method: event.httpMethod || "GET",
    headers: event.headers || {},
  };

  if(init.method !== "GET" && init.method !== "HEAD" && typeof event.body === "string"){
    init.body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;
  }

  const req = new Request(url, init);
  const res = await handler(req);

  const headersObj = {};
  res.headers.forEach((v, k) => { headersObj[k] = v; });
  const body = await res.text();

  return {
    statusCode: res.status,
    headers: headersObj,
    body
  };
};
