// Netlify Function: /api/create-checkout
// Creates Stripe Checkout Session (subscription) for authenticated Supabase user.

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
  const r = await sbFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,stripe_customer_id`);
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

async function updateProfile(userId, patch){
  const r = await sbFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method:"PATCH",
    headers:{ "Content-Type":"application/json", "Prefer":"return=representation" },
    body: JSON.stringify(patch)
  });
  if(!r.ok) throw new Error("Failed to update profile");
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
    const priceId = process.env.STRIPE_PRICE_ID;
    if(!priceId) return new Response("Missing STRIPE_PRICE_ID", { status:500 });

    const profile = await getProfile(user.id);
    let customerId = profile?.stripe_customer_id || "";

    if(!customerId){
      const customer = await stripePostForm("/v1/customers", {
        email: user.email || "",
        "metadata[supabase_user_id]": user.id
      });
      customerId = customer.id;
      await updateProfile(user.id, { stripe_customer_id: customerId, email: user.email || profile?.email || null });
    }

    const base = (process.env.PUBLIC_SITE_URL || baseUrlFromReq(req)).replace(/\/$/, "");
    const success_url = `${base}/?success=1`;
    const cancel_url = `${base}/?canceled=1`;

    const session = await stripePostForm("/v1/checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      success_url,
      cancel_url,
      allow_promotion_codes: "true",
      client_reference_id: user.id,
      "metadata[supabase_user_id]": user.id,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[metadata][supabase_user_id]": user.id
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status:200,
      headers:{ "Content-Type":"application/json", "Cache-Control":"no-store" }
    });
  }catch(err){
    return new Response(err?.message || "checkout error", { status: 500 });
  }
};
