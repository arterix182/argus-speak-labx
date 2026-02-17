/* otp-patch-v2.js
   Add-on script: fixes "Enviar código / Verificar" even if the app failed to bind listeners.
   Safe: does not replace your main app JS. Load AFTER app-18.js (or app.js).
*/
(() => {
  "use strict";
  const BUILD = "otp_patch_v2";
  window.__OTP_PATCH_BUILD__ = BUILD;

  const log = (...a) => console.log(`[OTP PATCH ${BUILD}]`, ...a);
  const warn = (...a) => console.warn(`[OTP PATCH ${BUILD}]`, ...a);
  const err = (...a) => console.error(`[OTP PATCH ${BUILD}]`, ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else fn();
  }

  function norm(s) {
    return (s || "").toString().trim().toLowerCase();
  }

  function textOf(el) {
    if (!el) return "";
    return (el.innerText || el.value || el.textContent || "").trim();
  }

  function matchesButton(el, label) {
    if (!el) return false;
    const t = norm(textOf(el));
    const l = norm(label);
    return t === l || t.includes(l);
  }

  function closestClickable(target) {
    if (!target) return null;
    return target.closest?.("button, a, [role='button'], input[type='button'], input[type='submit']") || null;
  }

  function findAccountScope() {
    // Try to find the account modal/card by its heading text
    const needle = "Cuenta & Suscripción";
    const els = Array.from(document.querySelectorAll("h1,h2,h3,div,section,dialog"));
    const hit = els.find((el) => (el.textContent || "").includes(needle));
    return hit ? (hit.closest("dialog,section,div") || hit) : document;
  }

  function qWithin(scope, sel) {
    try { return scope.querySelector(sel); } catch { return null; }
  }

  function emailInput(scope) {
    return (
      qWithin(scope, "input[type='email']") ||
      qWithin(scope, "input[name*='email' i]") ||
      qWithin(scope, "input[autocomplete='email']") ||
      qWithin(scope, "input[placeholder*='correo' i]") ||
      qWithin(scope, "input[placeholder*='email' i]") ||
      null
    );
  }

  function codeInput(scope) {
    // Prefer explicit OTP fields; fallback to numeric input inside account scope
    return (
      qWithin(scope, "input[autocomplete='one-time-code']") ||
      qWithin(scope, "input[name*='code' i]") ||
      qWithin(scope, "input[placeholder*='código' i]") ||
      qWithin(scope, "input[placeholder*='codigo' i]") ||
      qWithin(scope, "input[inputmode='numeric']") ||
      null
    );
  }

  function tightenOtpInput(scope) {
    const inp = codeInput(scope);
    if (!inp) return;
    // Allow 6–12 digits (Supabase sometimes sends 8).
    inp.setAttribute("maxlength", "12");
    inp.setAttribute("inputmode", "numeric");
    inp.setAttribute("autocomplete", "one-time-code");
    inp.addEventListener("input", () => {
      inp.value = (inp.value || "").replace(/\D+/g, "").slice(0, 12);
    });
  }

  function hideMagicLinkUI(scope) {
    // Hide the "Enviar link" button and the "link mágico" hint line if present.
    const buttons = Array.from(scope.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"));
    for (const b of buttons) {
      if (matchesButton(b, "Enviar link") || matchesButton(b, "Send link")) {
        b.style.display = "none";
        b.setAttribute("data-otp-patch-hidden", "1");
      }
    }
    // Hide text nodes by wrapping parent blocks if they contain the phrase.
    const blocks = Array.from(scope.querySelectorAll("p,div,span,small"));
    for (const el of blocks) {
      const t = (el.textContent || "");
      if (t.includes("link mágico") || t.includes("link magico") || t.includes("magic link")) {
        // Don't hide the whole modal; just reduce this line.
        el.style.display = "none";
        el.setAttribute("data-otp-patch-hidden", "1");
      }
    }
  }

  async function fetchConfig() {
    const urls = ["/api/config", "/config", "/.netlify/functions/config", "/config.json"];
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json().catch(() => null);
        if (j && (j.supabaseUrl || j.url) && (j.supabaseAnonKey || j.anonKey || j.supabaseKey || j.publicKey)) {
          log("Config OK from", u);
          return j;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function getOrCreateSupabase(cfg) {
    // If app already created it, reuse.
    const existing = window.supabaseClient || window.__supabaseClient || window._supabaseClient;
    if (existing?.auth?.signInWithOtp) return existing;

    const sb = window.supabase;
    if (!sb?.createClient) {
      warn("Supabase library not found on window.supabase (did supabase.min.js load?)");
      return null;
    }

    const url = (cfg.supabaseUrl || cfg.url || "").replace(/\/$/, "");
    const key = cfg.supabaseAnonKey || cfg.anonKey || cfg.supabaseKey || cfg.publicKey || "";
    if (!url || !key) return null;

    const client = sb.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      global: { headers: { "X-Client-Info": "otp-patch-v2" } }
    });

    // Expose so the app can also pick it up if it wants.
    window.supabaseClient = client;
    return client;
  }

  async function sendOtp(scope) {
    const emailEl = emailInput(scope);
    const email = norm(emailEl?.value);
    if (!email || !email.includes("@")) {
      alert("Pon un email válido primero.");
      emailEl?.focus?.();
      return;
    }

    const cfg = await fetchConfig();
    if (!cfg) {
      alert("No pude leer /api/config (o /config). Revisa que exista y devuelva supabaseUrl + sb_publishable.");
      return;
    }

    const client = getOrCreateSupabase(cfg);
    if (!client) {
      alert("No se pudo crear Supabase client. ¿Se cargó supabase.min.js?");
      return;
    }

    log("Sending OTP to", email);
    const { error } = await client.auth.signInWithOtp({
      email,
      options: {
        // Avoid magic link redirects; still allows OTP.
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true
      }
    });

    if (error) {
      err("signInWithOtp error", error);
      alert("Error enviando código: " + (error.message || error.toString()));
      return;
    }

    tightenOtpInput(scope);
    alert("Listo. Revisa tu correo: usa el ÚLTIMO código recibido.");
  }

  async function verifyOtp(scope) {
    const emailEl = emailInput(scope);
    const email = norm(emailEl?.value);
    if (!email || !email.includes("@")) {
      alert("Pon tu email primero.");
      emailEl?.focus?.();
      return;
    }

    const codeEl = codeInput(scope);
    const token = (codeEl?.value || "").replace(/\D+/g, "").slice(0, 12);
    if (token.length < 6) {
      alert("Pega el código completo (6 a 12 dígitos).");
      codeEl?.focus?.();
      return;
    }

    const cfg = await fetchConfig();
    if (!cfg) {
      alert("No pude leer config. Revisa /api/config o /config.");
      return;
    }

    const client = getOrCreateSupabase(cfg);
    if (!client) {
      alert("No se pudo crear Supabase client.");
      return;
    }

    log("Verifying OTP", { email, token_len: token.length });

    // Supabase expects type 'email' for email OTP.
    const { data, error } = await client.auth.verifyOtp({ email, token, type: "email" });

    if (error) {
      err("verifyOtp error", error);
      alert("❌ Token inválido/expirado. Tip: usa el ÚLTIMO código, y verifica en menos de 5 min.\n\n" + (error.message || ""));
      return;
    }

    log("OTP verified. Session:", !!data?.session);
    alert("✅ Listo. Sesión iniciada. Si no se actualiza la UI, recarga la app.");
    // Many apps listen to auth state; also force a soft refresh.
    try {
      window.dispatchEvent(new Event("auth:updated"));
    } catch { /* ignore */ }
    await sleep(200);
    location.reload();
  }

  function installClickDelegate() {
    document.addEventListener("click", async (e) => {
      try {
        const btn = closestClickable(e.target);
        if (!btn) return;

        const scope = findAccountScope();

        // Only act when Account modal is present/visible-ish.
        const scopeText = (scope.textContent || "");
        if (!scopeText.includes("Cuenta") && !scopeText.includes("Suscripción") && !scopeText.includes("Subscription")) return;

        // Hide magic link UI gently.
        hideMagicLinkUI(scope);
        tightenOtpInput(scope);

        if (matchesButton(btn, "Enviar código") || matchesButton(btn, "Send code")) {
          e.preventDefault();
          e.stopPropagation();
          await sendOtp(scope);
          return;
        }

        if (matchesButton(btn, "Verificar") || matchesButton(btn, "Verify")) {
          e.preventDefault();
          e.stopPropagation();
          await verifyOtp(scope);
          return;
        }
      } catch (ex) {
        err("delegate crash", ex);
      }
    }, true);

    log("Installed click delegate for Enviar código / Verificar");
  }

  onReady(() => {
    try {
      installClickDelegate();
      // Attempt to patch inputs/UI if account modal is already rendered.
      const scope = findAccountScope();
      hideMagicLinkUI(scope);
      tightenOtpInput(scope);
    } catch (ex) {
      err("init crash", ex);
    }
  });
})();
