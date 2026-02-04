// Netlify Function: /api/create-portal
// Opens Stripe Customer Portal for authenticated user.

async function stripePostForm(path, params){
  const key = process.env.STRIPE_SECRET_KEY;
  if(!key) throw new Error("Missing STRIPE_SECRET_KEY");
  const body = new URLSearchParams(params).toString();

  const r = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const text = await r.text();
  let json = null;
  try{ json = JSON.parse(text); }catch(_){}
  if(!r.ok){
    const msg = json?.error?.message || text || `Stripe error ${r.status}`;
    throw new Error(msg);
  }
  return json;
}

async function getSupabaseUser(req){
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if(!supabaseUrl || !anonKey) return { error:"Missing SUPABASE_URL / SUPABASE_ANON_KEY", status:500 };

  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if(!m) return { error:"Missing Authorization Bearer token", status:401 };

  const token = m[1];
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { "apikey": anonKey, "Authorization": `Bearer ${token}` }
  });
  if(!r.ok) return { error:"Invalid session", status:401 };
  const user = await r.json();
  return { user };
}

async function sbFetch(path, init={}){
  const supabaseUrl = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!supabaseUrl || !service) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const r = await fetch(`${supabaseUrl}${path}`, {
    ...init,
    headers: {
      "apikey": service,
      "Authorization": `Bearer ${service}`,
      ...(init.headers || {})
    }
  });
  return r;
}

async function getProfile(userId){
  const r = await sbFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`);
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

function baseUrlFromReq(req){
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const proto = req.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

export default async (req) => {
  try{
    if(req.method !== "POST") return new Response("Method not allowed", { status:405 });

    const s = await getSupabaseUser(req);
    if(s?.error) return new Response(s.error, { status: s.status || 401 });

    const user = s.user;
    const profile = await getProfile(user.id);
    const customer = profile?.stripe_customer_id;
    if(!customer) return new Response("No Stripe customer for this user. Subscribe first.", { status: 400 });

    const base = baseUrlFromReq(req);
    const portal = await stripePostForm("/v1/billing_portal/sessions", {
      customer,
      return_url: base + "/"
    });

    return new Response(JSON.stringify({ url: portal.url }), { status:200, headers:{ "Content-Type":"application/json", "Cache-Control":"no-store" }});
  }catch(err){
    return new Response(err?.message || "portal error", { status: 500 });
  }
};
