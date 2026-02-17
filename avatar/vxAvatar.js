// vxAvatar.js — Avatar vivo + lip-sync (sin 3D, pero se siente premium)

(() => {
  // Estado visual
  let state = "idle";
  let mouth = 0.08;         // 0..1
  let glow = 0.0;           // 0..1
  let raf = null;
  let blinkTimer = null;

  function setCSSVar(name, val){
    document.documentElement.style.setProperty(name, String(val));
  }

  function setBadge(s){
    const el = document.getElementById("avatarBadge");
    if (el) el.textContent = s;
  }

  // Animación suave de mouth/glow
  function tick(){
    // “respiración” base
    const base = (state === "speaking") ? 0.08 : 0.06;
    const targetGlow =
      state === "listening" ? 0.9 :
      state === "thinking" ? 0.65 :
      state === "speaking" ? 0.8 :
      state === "error" ? 0.95 : 0.25;

    glow = glow + (targetGlow - glow) * 0.06;

    // si no está speaking, vuelve a boca base
    if (state !== "speaking") {
      mouth = mouth + ((base) - mouth) * 0.08;
    }

    setCSSVar("--mouth", mouth.toFixed(3));
    setCSSVar("--glow", glow.toFixed(3));

    raf = requestAnimationFrame(tick);
  }

  function blink(){
    const L = document.getElementById("eyeL");
    const R = document.getElementById("eyeR");
    if (!L || !R) return;

    L.style.transform = "scaleY(0.15)";
    R.style.transform = "scaleY(0.15)";
    setTimeout(() => {
      L.style.transform = "scaleY(1)";
      R.style.transform = "scaleY(1)";
    }, 120);

    // próximo parpadeo
    const next = 2200 + Math.random() * 2600;
    blinkTimer = setTimeout(blink, next);
  }

  // === Lip-sync: analiza el audio mientras suena ===
  async function playWithLipSync(arrayBuffer){
    // Crea un AudioContext para reproducir y analizar
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

    const src = ctx.createBufferSource();
    src.buffer = decoded;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    const gain = ctx.createGain();
    gain.gain.value = 1;

    src.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);

    const buf = new Uint8Array(analyser.fftSize);
    state = "speaking";
    setBadge("speaking");

    let running = true;

    const loop = () => {
      if (!running) return;

      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / buf.length); // 0..1
      // mapea a boca (ganancia)
      const target = Math.max(0.06, Math.min(0.95, rms * 4.2));
      mouth = mouth + (target - mouth) * 0.22;

      requestAnimationFrame(loop);
    };

    loop();

    return new Promise((resolve, reject) => {
      src.onended = async () => {
        running = false;
        try { await ctx.close(); } catch {}
        // vuelve a idle (o lo que el sistema marque)
        resolve();
      };
      try {
        src.start(0);
      } catch (e) {
        running = false;
        reject(e);
      }
    });
  }

  // API pública para el index / pipeline
  window.VX_avatarSetState = (s) => {
    state = s || "idle";
    setBadge(state);
    // color “error” sin complicar
    if (state === "error") {
      // sube boca un poco para dramatismo
      mouth = 0.20;
    }
  };

  // Hook: si existe VX_playAudio (del pipeline), lo envolvemos para lip-sync
  const originalPlay = window.VX_playAudio;
  if (typeof originalPlay === "function") {
    window.VX_playAudio = async (buf) => {
      try {
        // intenta lip-sync real
        await playWithLipSync(buf);
      } catch (e) {
        // si falla, reproduce normal
        console.warn("LipSync fallback:", e);
        await originalPlay(buf);
      }
    };
  }

  // Arranque
  setBadge("idle");
  if (!raf) tick();
  if (!blinkTimer) blink();
  console.log("✅ vxAvatar loaded (lip-sync + states)");
})();
