// index.js — Servicio24 V2 Barzel Stable (Final + Idempotency)
// - Graph API v${GRAPH_VERSION} corrected
// - Redis sessions with in-memory fallback
// - Full emojis for ZONAS and services (word first, emoji after)
// - Free-text logic: same menu before DONE, final confirmation after DONE
// - Idempotency (ignore duplicate WhatsApp events) + UI de-dupe window
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
async function sessSet(userId, s, ttlSec = 60 * 60 * 6) {
  if (!useMemory && redis) {
    await redis.set(`s24:sess:${userId}`, JSON.stringify(s), "EX", ttlSec);
  } else {
    mem.set(userId, s);
    setTimeout(() => mem.delete(userId), ttlSec * 1000).unref?.();
  }
}

// ===== Idempotency (anti-duplicate events) =====
const seenInMem = new Set();
async function alreadyHandled(msgId, ttlSec = 60 * 60 * 24) {
  const key = `s24:seen:${msgId}`;
  if (!useMemory && redis) {
    const exists = await redis.get(key);
    if (exists) return true;
    await redis.set(key, "1", "EX", ttlSec);
    return false;
  } else {
    if (seenInMem.has(key)) return true;
    seenInMem.add(key);
    setTimeout(() => seenInMem.delete(key), ttlSec * 1000).unref?.();
    return false;
  }
}

// מניעת שליחת אותו מסך ברצף בחלון זמן קצר (דיפולט 30 שניות)
async function sendOncePerState(from, s, stateKey, sendFn, minGapMs = 30_000) {
  const now = Date.now();
  if (s.lastStateKey === stateKey && s.lastStateAt && (now - s.lastStateAt) < minGapMs) {
    return;
  }
  await sendFn();
  s.lastStateKey = stateKey;
  s.lastStateAt = now;
  await sessSet(from, s);
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
  const consent = "_Al continuar, aceptas que tus datos se compartan con profesionales cercanos y que puedas recibir sus llamadas o mensajes. Sin costo._";
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
  return text; // לשימוש חוזר במסך DONE
}

// ===== Free-text behavior =====
async function recoverUI(from, s) {
  if (s.state === "DONE") {
    const cityTitle = s.city?.title || "Ciudad de Guatemala";
    const svc = s.serviceId || null;
    const final = s.lastConfirmation ||
      `Listo ✅  ${(SERVICES.find(x => x.id === svc)?.label || "Profesional")} ${(SERVICES.find(x => x.id === svc)?.emoji || "👤")} • Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")} • ${cityTitle}.\nEn breve te contactarán profesionales cercanos.\n\nServicio24`;
    await sendText(from, final);
    return;
  }

  if (!s.started) { await sendOncePerState(from, s, "start", () => sendStartConfirm(from)); return; }
  if (!s.city)    { await sendOncePerState(from, s, "city",  () => sendCityMenu(from));    return; }
  if (!s.zone)    { await sendOncePerState(from, s, "zones", () => sendZonaGroupButtons(from)); return; }
  if (!s.zoneConfirmed) { await sendOncePerState(from, s, `zconfirm:${s.zone}`, () => sendZonaConfirm(from, s.zone)); return; }

  const cityTitle = s.city?.title || "Ciudad de Guatemala";
  await sendOncePerState(from, s, `services:${s.city?.id}:${s.zone}`, () => sendServicesList(from, cityTitle, s.zone));
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

    // ---- Idempotency: ignore duplicate deliveries ----
    if (await alreadyHandled(msg.id)) {
      return res.sendStatus(200);
    }

    const from = msg.from;
    let s = await sessGet(from);
    if (!s) {
      s = { city: null, zone: null, zoneConfirmed: false, serviceId: null, started: false, state: "MENU", lastConfirmation: null, lastStateKey: null, lastStateAt: null };
      await sessSet(from, s);
    }

    // TEXT
    if (msg.type === "text") {
      if (s.state === "DONE") {
        const text = s.lastConfirmation || `Listo ✅  ${(SERVICES.find(x => x.id === s.serviceId)?.label || "Profesional")} ${(SERVICES.find(x => x.id === s.serviceId)?.emoji || "👤")} • Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")} • ${(s.city?.title || "Ciudad de Guatemala")}.\nEn breve te contactarán profesionales cercanos.\n\nServicio24`;
        await sendText(from, text);
        return res.sendStatus(200);
      }
      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // עיר
      if (CITIES.some(c => c.id === id)) {
        const city = CITIES.find(c => c.id === id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.started = true; s.state = "MENU";
        await sessSet(from, s);
        await sendOncePerState(from, s, "zones", () => sendZonaGroupButtons(from));
        return res.sendStatus(200);
      }

      // זונה מדויקת
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z >= 1 && z <= 25) {
          s.zone = z; s.zoneConfirmed = false; s.state = "MENU";
          await sessSet(from, s);
          await sendOncePerState(from, s, `zconfirm:${z}`, () => sendZonaConfirm(from, z));
          return res.sendStatus(200);
        }
      }

      // שירות
      if (SERVICE_LABEL[id]) {
        if (!s.zoneConfirmed) {
          await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
          await sendOncePerState(from, s, "zones", () => sendZonaGroupButtons(from));
          return res.sendStatus(200);
        }
        s.serviceId = id;
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
        s.state = "DONE";
        s.lastConfirmation = finalText;
        await sessSet(from, s);
        return res.sendStatus(200);
      }
    }

    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes") {
        s.started = true; s.state = "MENU"; await sessSet(from, s);
        await sendOncePerState(from, s, "role", () => sendRoleButtons(from));
        return res.sendStatus(200);
      }
      if (id === "start_no")  { await sendText(from, "Operación cancelada.\n\nServicio24"); return res.sendStatus(200); }

      if (id === "role_cliente") { await sendOncePerState(from, s, "city", () => sendCityMenu(from)); return res.sendStatus(200); }
      if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24"); return res.sendStatus(200); }

      if (id === "zona_group_1_10")  { await sendOncePerState(from, s, "zlist:1-10",  () => sendZonaList(from, 1, 10));  return res.sendStatus(200); }
      if (id === "zona_group_11_20") { await sendOncePerState(from, s, "zlist:11-20", () => sendZonaList(from, 11, 20)); return res.sendStatus(200); }
      if (id === "zona_group_21_25") { await sendOncePerState(from, s, "zlist:21-25", () => sendZonaList(from, 21, 25)); return res.sendStatus(200); }

      if (id === "zona_change") { s.state = "MENU"; await sessSet(from, s); await sendOncePerState(from, s, "zones", () => sendZonaGroupButtons(from)); return res.sendStatus(200); }
      if (id === "zona_confirm") {
        if (!s.zone) { await sendOncePerState(from, s, "zones", () => sendZonaGroupButtons(from)); return res.sendStatus(200); }
        s.zoneConfirmed = true; s.state = "MENU";
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendOncePerState(from, s, `services:${s.city?.id}:${s.zone}`, () => sendServicesList(from, cityTitle, s.zone));
        return res.sendStatus(200);
      }
    }

    // fallback אם עדיין אין עיר
    if (!s.city) {
      await sendOncePerState(from, s, "city", () => sendCityMenu(from));
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ===== Health =====
app.get("/", (_req, res) => res.status(200).send("🚀 Servicio24 — V2 Barzel Stable (Redis + Full Emojis + Idempotency)"));

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V2 Barzel Stable + Idempotency]`));
