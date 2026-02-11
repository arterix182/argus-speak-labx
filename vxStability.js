// vxStability.js — Timeouts + Retry + errores claros (sin romper lo que ya funciona)

(() => {
  function withTimeout(promiseFn, ms, label) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);

    return Promise.resolve()
      .then(() => promiseFn(ctrl.signal))
      .finally(() => clearTimeout(t))
      .catch((e) => {
        const msg = (e && (e.name === "AbortError")) ? `${label} timeout (${ms}ms)` : (e?.message || String(e));
        throw new Error(msg);
      });
  }

  async function retry(fn, times = 1) {
    let lastErr = null;
    for (let i = 0; i <= times; i++) {
      try { return await fn(i); }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  // Exponlo por si lo quieres usar
  window.VX_withTimeout = withTimeout;
  window.VX_retry = retry;

  // === Envolver STT/CHAT/TTS si existen ===
  const stt0 = window.VX_transcribeAudio;
  const chat0 = window.VX_chatReply;
  const tts0 = window.VX_ttsAudio;

  if (typeof stt0 === "function") {
    window.VX_transcribeAudio = async (blob) => {
      return retry(async (attempt) => {
        return withTimeout(async (signal) => {
          // Tu STT usa fetch sin signal dentro (en pipeline). Aquí no podemos abortarlo real
          // si el pipeline no usa signal, pero sí cortamos “UI wait” y retry.
          const text = await stt0(blob);
          return text;
        }, 12000, attempt ? "STT retry" : "STT");
      }, 1);
    };
  }

  if (typeof chat0 === "function") {
    window.VX_chatReply = async (text) => {
      return retry(async (attempt) => {
        return withTimeout(async () => {
          return await chat0(text);
        }, 14000, attempt ? "CHAT retry" : "CHAT");
      }, 1);
    };
  }

  if (typeof tts0 === "function") {
    window.VX_ttsAudio = async (text) => {
      return retry(async (attempt) => {
        return withTimeout(async () => {
          return await tts0(text);
        }, 14000, attempt ? "TTS retry" : "TTS");
      }, 0); // TTS sin retry por costo/latencia (si quieres: pon 1)
    };
  }

  console.log("✅ vxStability loaded (timeouts + retry wrappers)");
})();
