// Netlify Function: /api/config
// Exposes only "safe" public config (Supabase anon key is OK to expose).

export default async () => {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  const appName = process.env.APP_NAME || "ARGUS SPEAK LAB-X";

  // Public URL of the app (safe to expose). Used for auth redirects and Stripe returns.
  const publicAppUrl =
    (process.env.PUBLIC_APP_URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  return new Response(JSON.stringify({ supabaseUrl, supabaseAnonKey, appName, publicAppUrl }), {
    status: 200,
    headers: { "Content-Type":"application/json", "Cache-Control":"no-store" }
  });
};
