// Netlify Function: /api/me
// Verifies Supabase JWT, returns user + subscription status.

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
  if(!r.ok){
    return { error:"Invalid session", status:401 };
  }
  const user = await r.json();
  return { user, token };
}

async function getProfileByUserId(userId){
  const supabaseUrl = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!supabaseUrl || !service) return null;

  const url = `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status,subscription_current_period_end,stripe_customer_id`;
  const r = await fetch(url, {
    headers: { "apikey": service, "Authorization": `Bearer ${service}` }
  });
  if(!r.ok) return null;
  const rows = await r.json();
  return rows?.[0] || null;
}

function isPro(profile){
  const st = (profile?.subscription_status || "").toLowerCase();
  if(st !== "active" && st !== "trialing") return false;
  // If we have a period end, ensure it is not in the past
  const end = profile?.subscription_current_period_end ? Date.parse(profile.subscription_current_period_end) : NaN;
  if(!Number.isNaN(end) && end < Date.now() - 60_000) return false;
  return true;
}

export default async (req) => {
  try{
    const s = await getSupabaseUser(req);
    if(s?.error) return new Response(s.error, { status: s.status || 401 });

    const user = s.user;
    const profile = await getProfileByUserId(user.id);

    const subscription = {
      status: profile?.subscription_status || "inactive",
      current_period_end: profile?.subscription_current_period_end || null
    };

    return new Response(JSON.stringify({
      user: { id: user.id, email: user.email },
      subscription,
      pro: isPro(profile)
    }), { status:200, headers:{ "Content-Type":"application/json", "Cache-Control":"no-store" }});
  }catch(err){
    return new Response(err?.message || "me error", { status: 500 });
  }
};
