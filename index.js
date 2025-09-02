// index.js — Servicio24 V2 Barzel Stable (Final+Lock)
// - Graph API v${GRAPH_VERSION} corrected
// - Redis sessions with in-memory fallback
// - Full emojis for ZONAS and services
// - Free-text logic + POST-LEAD LOCK (no loops)
// - No dotenv (Render reads ENV)

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== Graph / Auth =====
const GRAPH_VERSION = process.env.GRAPH_VERSION || "23.0"; // ב-Render הערך 23.0 בלי v
const GRAPH_BASE    = `https://graph.facebook.com/v${GRAPH_VERSION}`;
const GRAPH_URL     = `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

if (!process.env.WHATSAPP_TOKEN || !process.env.PHONE_NUMBER_ID) {
  console.error("❌ Missing env: WHATSAPP_TOKEN or PHONE_NUMBER_ID");
  process.exit(1);
}

// ===== Redis sessions (fallback to memory) =====
let redis = null;
let useMemory = false;
try {
  const Redis = require("ioredis");
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on("connect", () => console.log("[Redis] connected"));
    redis.on("error", (e) => {
      console.error("[Redis] error:", e?.message || e);
      redis = null;
      useMemory = true;
    });
  } else {
    useMemory = true;
    console.warn("[Redis] REDIS_URL missing - using in-memory sessions");
  }
} catch {
  useMemory = true;
  console.warn("[Redis] ioredis not available - using in-memory sessions");
}

const mem = new Map();
async function sessGet(userId) {
  if (!useMemory && redis) {
    const raw = await redis.get(`s24:sess:${userId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.get(userId) || null;
}
async function sessSet(userId, s, ttlSec = 60 * 60 * 24) { // 24h TTL
  s.ts = Date.now();
  if (!useMemory && redis) {
    await redis.set(`s24:sess:${userId}`, JSON.stringify(s), "EX", ttlSec);
  } else {
    mem.set(userId, s);
    setTimeout(() => mem.delete(userId), ttlSec * 1000).unref?.();
  }
}

// ===== Datos LOCKED =====
const CITIES = [{ id: "city_guatemala", title: "Ciudad de Guatemala" }];

const SERVICES = [
  { id: "srv_plomero",      label: "Plomero",            emoji: "🚰" },
  { id: "srv_electricista", label: "Electricista",       emoji: "⚡" },
  { id: "srv_cerrajero",    label: "Cerrajero",          emoji: "🔑" },
  { id: "srv_aire",         label: "Aire acondicionado", emoji: "❄️" },
  { id: "srv_mecanico",     label: "Mecánico",           emoji: "🛠️" },
  { id: "srv_grua",         label: "Servicio de grúa",   emoji: "🛻" },
  { id: "srv_mudanza",      label: "Mudanza",            emoji: "🚚" },
];
const SERVICE_LABEL = Object.fromEntries(SERVICES.map(s => [s.id, s.label]));

const ZONA_EMOJI = {
  1:"🏛️",2:"🍺",3:"🕊️",4:"💰",5:"🏟️",6:"🏘️",7:"🏺",8:"🚌",9:"🏨",10:"🎉",
  11:"🛒",12:"🧰",13:"✈️",14:"🏢",15:"🎓",16:"🏰",17:"🏭",18:"🛣️",19:"🔧",20:"🏚️",
  21:"🚧",22:"📦",23:"🚋",24:"🏗️",25:"🌳"
};

// ===== UI senders =====
function postWA(payload) {
  return axios.post(GRAPH_URL, payload, AUTH);
}
function sendText(to, text) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}

// pantalla inicial
function sendStartConfirm(to) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Servicio24" },
      body:   { text: "¿Deseas iniciar tu solicitud?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "start_yes", title: "Confirmar" } },
          { type: "reply", reply: { id: "start_no",  title: "Cancelar" } },
        ],
      },
    },
  });
}

// role
function sendRoleButtons(to) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Bienvenido a Servicio24" },
      body:   { text: "*Selecciona tu rol:*" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "role_cliente", title: "Cliente" } },
          { type: "reply", reply: { id: "role_tecnico", title: "Técnico" } },
        ],
      },
    },
  });
}

// city list
function sendCityMenu(to) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Selecciona tu ciudad" },
      body:   { text: "Elige la ciudad donde necesitas el servicio:" },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar ciudad",
        sections: [
          { title: "Ciudades", rows: CITIES.map(c => ({ id: c.id, title: c.title })) }
        ]
      }
    }
  });
}

// zona groups
function sendZonaGroupButtons(to) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Zonas" },
      body:   { text: "Selecciona tu zona:" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "zona_group_1_10",  title: "Zonas 1-10" } },
          { type: "reply", reply: { id: "zona_group_11_20", title: "Zonas 11-20" } },
          { type: "reply", reply: { id: "zona_group_21_25", title: "Zonas 21-25" } },
        ]
      }
    }
  });
}

// zona list exacta
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) {
    rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  }
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body:   { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar zona", sections: [{ title: "Zonas", rows }] }
    }
  });
}

// confirm zona
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: `Zona seleccionada: ${z} ${emoji}` },
      body:   { text: "¿Desea continuar con esta zona?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "zona_confirm", title: "Confirmar" } },
          { type: "reply", reply: { id: "zona_change",  title: "Cambiar zona" } },
        ]
      }
    }
  });
}

// services list
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent =
    "_Al continuar, aceptas que tus datos se compartan con profesionales cercanos y que puedas recibir sus llamadas o mensajes. Sin costo._";
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body:   { text: `Selecciona el profesional que necesitas:\n${cityTitle} • Zona ${z} ${zEmoji}\n\n${consent}` },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [
          {
            title: "Profesionales",
            rows: SERVICES.map(s => ({ id: s.id, title: `${s.label} ${s.emoji}` }))
          }
        ]
      }
    }
  });
}

// final lead
async function sendLeadReady(to, cityTitle, zone, serviceId) {
  const svc = SERVICES.find(s => s.id === serviceId);
  const serviceText = svc ? `${svc.label} ${svc.emoji}` : "Profesional 👤";
  const zoneEmoji = ZONA_EMOJI[zone] || "";
  const text =
    `Listo ✅  ${serviceText} • Zona ${zone} ${zoneEmoji} • ${cityTitle}.\n` +
    `En breve te contactarán profesionales cercanos.\n\nServicio24`;
  await sendText(to, text);
  return text; // נשמר לשימוש במסך DONE
}

// ===== Free-text & Lock behavior =====
async function recoverUI(from, s) {
  if (s.state === "DONE" || s.locked) {
    const cityTitle = s.city?.title || "Ciudad de Guatemala";
    const svc = s.serviceId || null;
    const final = s.lastConfirmation ||
      `Listo ✅  ${(SERVICES.find(x => x.id === svc)?.label || "Profesional")} ${(SERVICES.find(x => x.id === svc)?.emoji || "👤")} • Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")} • ${cityTitle}.\nEn breve te contactarán profesionales cercanos.\n\nServicio24`;
    await sendText(from, final);
    return;
  }

  if (!s.started) { await sendStartConfirm(from); return; }
  if (!s.city) { await sendCityMenu(from); return; }
  if (!s.zone) { await sendZonaGroupButtons(from); return; }
  if (!s.zoneConfirmed) { await sendZonaConfirm(from, s.zone); return; }
  const cityTitle = s.city?.title || "Ciudad de Guatemala";
  await sendServicesList(from, cityTitle, s.zone);
}

// ===== Webhook verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Webhook receive =====
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    let s = await sessGet(from);
    if (!s) {
      s = {
        city: null, zone: null, zoneConfirmed: false, serviceId: null,
        started: false, state: "MENU", lastConfirmation: null, locked: false, ts: Date.now()
      };
      await sessSet(from, s);
    }

    // TEXT: lock-aware
    if (msg.type === "text") {
      const txt = (msg.text?.body || "").trim().toLowerCase();

      // מילים שמבצעות reset יזום
      const RESET_WORDS = new Set(["menu", "nuevo", "reiniciar", "reset", "inicio", "start"]);
      if (RESET_WORDS.has(txt)) {
        s = {
          city: null, zone: null, zoneConfirmed: false, serviceId: null,
          started: false, state: "MENU", lastConfirmation: null, locked: false, ts: Date.now()
        };
        await sessSet(from, s);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }

      if (s.locked || s.state === "DONE") {
        // אחרי יצירת ליד—לא מחזירים לתפריטים
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const final = s.lastConfirmation ||
          `Listo ✅  ${(SERVICES.find(x => x.id === s.serviceId)?.label || "Profesional")} ${(SERVICES.find(x => x.id === s.serviceId)?.emoji || "👤")} • Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")} • ${cityTitle}.\nEn breve te contactarán profesionales cercanos.\n\nServicio24`;
        await sendText(from, final);
        return res.sendStatus(200);
      }

      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // ciudad
      if (CITIES.some(c => c.id === id)) {
        const city = CITIES.find(c => c.id === id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.started = true; s.state = "MENU";
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // zona exacta
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z >= 1 && z <= 25) {
          s.zone = z; s.zoneConfirmed = false; s.state = "MENU";
          await sessSet(from, s);
          await sendZonaConfirm(from, z);
          return res.sendStatus(200);
        }
      }

      // servicio
      if (SERVICE_LABEL[id]) {
        if (!s.zoneConfirmed) {
          await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
          await sendZonaGroupButtons(from);
          return res.sendStatus(200);
        }
        s.serviceId = id;
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
        s.state = "DONE";
        s.locked = true;                // 🔒 נועל את ה-session
        s.lastConfirmation = finalText; // נשמר להצגה חוזרת
        await sessSet(from, s);
        return res.sendStatus(200);
      }
    }

    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes") { s.started = true; s.state = "MENU"; await sessSet(from, s); await sendRoleButtons(from); return res.sendStatus(200); }
      if (id === "start_no")  { await sendText(from, "Operación cancelada.\n\nServicio24"); return res.sendStatus(200); }

      if (id === "role_cliente") { await sendCityMenu(from); return res.sendStatus(200); }
      if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24"); return res.sendStatus(200); }

      if (id === "zona_group_1_10")  { await sendZonaList(from, 1, 10);  return res.sendStatus(200); }
      if (id === "zona_group_11_20") { await sendZonaList(from, 11, 20); return res.sendStatus(200); }
      if (id === "zona_group_21_25") { await sendZonaList(from, 21, 25); return res.sendStatus(200); }

      if (id === "zona_change") { s.state = "MENU"; await sessSet(from, s); await sendZonaGroupButtons(from); return res.sendStatus(200); }
      if (id === "zona_confirm") {
        if (!s.zone) { await sendZonaGroupButtons(from); return res.sendStatus(200); }
        s.zoneConfirmed = true; s.state = "MENU";
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendServicesList(from, cityTitle, s.zone);
        return res.sendStatus(200);
      }
    }

    // fallback אם עדיין אין עיר
    if (!s.city) {
      await sendCityMenu(from);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ===== Health =====
app.get("/", (_req, res) => res.status(200).send("🚀 Servicio24 — V2 Barzel Stable (Redis + Full Emojis + Lock)"));

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V2 Barzel Stable + Lock]`));
