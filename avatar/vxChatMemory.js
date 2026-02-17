// vxChatMemory.js
// Addon: agrega memoria corta + modos SIN tocar tu voicePipeline.js.
// Debe cargarse DESPUÉS de voicePipeline.js

(() => {
  // Memoria global
  window.VX_history = window.VX_history || [];
  window.VX_mode = window.VX_mode || "coach";

  window.VX_setMode = (m) => {
    const x = (m || "coach").toString().toLowerCase();
    window.VX_mode = x;
    console.log("✅ VX_mode =", window.VX_mode);
  };

  window.VX_clearMemory = () => {
    window.VX_history = [];
    console.log("🧹 VX_history cleared");
  };

  // Reemplaza VX_chatReply con versión con memoria + modos
  window.VX_chatReply = async (userText) => {
    const clean = (userText || "").toString().trim();
    if (!clean) throw new Error("Empty userText");

    // historial: últimos 6 turnos (12 mensajes)
    const history = (window.VX_history || []).slice(-12);

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText: clean,
        history,
        mode: window.VX_mode || "coach"
      })
    });

    let j;
    try { j = await r.json(); }
    catch { j = { error: "Non-JSON response from /api/chat" }; }

    if (!r.ok) throw new Error(JSON.stringify(j));

    const reply = (j.reply || "").toString().trim();
    if (!reply) throw new Error("Empty reply");

    // guarda memoria
    window.VX_history.push({ role: "user", content: clean });
    window.VX_history.push({ role: "assistant", content: reply });
    window.VX_history = window.VX_history.slice(-12);

    return reply;
  };

  console.log("✅ vxChatMemory loaded:", {
    VX_chatReply: typeof window.VX_chatReply,
    VX_setMode: typeof window.VX_setMode,
    VX_clearMemory: typeof window.VX_clearMemory
  });
})();
