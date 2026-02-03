// Netlify Function: /api/stripe-webhook
// Stripe webhooks -> update Supabase profile subscription_status.
//
// Required env:
// STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function timingSafeEqual(a, b){
  if(a.length !== b.length) return false;
  let out = 0;
  for(let i=0;i<a.length;i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return out === 0;
}

async function hmacSha256Hex(secret, data){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name:"HMAC", hash:"SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const bytes = new Uint8Array(sigBuf);
  return [...bytes].map(b => b.toString(16).padStart(2,"0")).join("");
}

function parseStripeSignature(sigHeader){
  // format: t=...,v1=...,v1=...
  const parts = (sigHeader||"").split(",").map(s => s.trim());
  const out = { t:null, v1:[] };
  for(const p of parts){
    const [k,v] = p.split("=");
    if(k==="t") out.t = v;
    if(k==="v1" && v) out.v1.push(v);
  }
  return out;
}

async function stripeGet(path){
  const key = process.env.STRIPE_SECRET_KEY;
  if(!key) throw new Error("Missing STRIPE_SECRET_KEY");
  const r = await fetch(`https://api.stripe.com${path}`, {
    headers: { "Authorization": `Bearer ${key}` }
  });
  const text = await r.text();
  let json=null; try{ json=JSON.parse(text);}catch(_){}
  if(!r.ok){
    const msg = json?.error?.message || text || `Stripe error ${r.status}`;
    throw new Error(msg);
  }
  return json;
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

async function findProfileByCustomer(customerId){
  const r = await sbFetch(`/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id`);
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

async function updateProfileById(userId, patch){
  const r = await sbFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method:"PATCH",
    headers:{ "Content-Type":"application/json", "Prefer":"return=representation" },
    body: JSON.stringify(patch)
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error("Supabase update failed: " + t);
  }
  const rows = await r.json();
  return rows?.[0] || null;
}

function isoFromUnixSeconds(sec){
  if(!sec) return null;
  const d = new Date(Number(sec) * 1000);
  return d.toISOString();
}

export default async (req) => {
  try{
    if(req.method !== "POST") return new Response("Method not allowed", { status:405 });

    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if(!secret) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status:500 });

    const sigHeader = req.headers.get("stripe-signature") || "";
    const { t, v1 } = parseStripeSignature(sigHeader);
    if(!t || !v1.length) return new Response("Missing signature", { status:400 });

    const rawBody = await req.text();
    const signedPayload = `${t}.${rawBody}`;
    const expected = await hmacSha256Hex(secret, signedPayload);

    const ok = v1.some(sig => timingSafeEqual(sig, expected));
    if(!ok) return new Response("Invalid signature", { status:400 });

    const event = JSON.parse(rawBody);
    const type = event?.type || "";
    const obj = event?.data?.object || {};

    // We’ll normalize into: customerId, status, currentPeriodEnd, subscriptionId
    let customerId = obj?.customer || null;
    let status = null;
    let currentPeriodEnd = null;
    let subscriptionId = null;

    if(type === "checkout.session.completed"){
      customerId = obj?.customer || customerId;
      subscriptionId = obj?.subscription || null;
      if(subscriptionId){
        const sub = await stripeGet(`/v1/subscriptions/${subscriptionId}`);
        status = sub?.status || null;
        currentPeriodEnd = isoFromUnixSeconds(sub?.current_period_end);
      }
    }

    if(type.startsWith("customer.subscription.")){
      customerId = obj?.customer || customerId;
      subscriptionId = obj?.id || null;
      status = obj?.status || null;
      currentPeriodEnd = isoFromUnixSeconds(obj?.current_period_end);
    }

    // Only act on relevant events
    const relevant = (type === "checkout.session.completed") || type.startsWith("customer.subscription.");
    if(!relevant) return new Response("ignored", { status: 200 });

    if(!customerId) return new Response("No customer id", { status: 200 });

    const profile = await findProfileByCustomer(customerId);

    // Fallback: use metadata if profile not found
    let userId = profile?.id || obj?.metadata?.supabase_user_id || obj?.subscription_data?.metadata?.supabase_user_id || null;

    if(!userId) return new Response("No matching user", { status: 200 });

    const patch = {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId || undefined,
      subscription_status: status || "inactive",
      subscription_current_period_end: currentPeriodEnd
    };

    // Remove undefined keys
    Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

    await updateProfileById(userId, patch);

    return new Response("ok", { status:200 });
  }catch(err){
    return new Response(err?.message || "webhook error", { status: 400 });
  }
};
