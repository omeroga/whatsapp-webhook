// index.js — Servicio24 V2 Barzel Stable (Final)
// - Graph API v${GRAPH_VERSION}
// - Redis sessions (fallback to memory)
// - Full emojis for ZONAS & services
// - Free-text flow + cooldown + magic reset
// - No dotenv (Render injects env)

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== Config (with safe defaults) =====
const GRAPH_VERSION      = process.env.GRAPH_VERSION || "23.0"; // set "23.0" (no 'v') in Render
const SESSION_TTL_HOURS  = parseInt(process.env.SESSION_TTL_HOURS || "6", 10);
const COOLDOWN_MINUTES   = parseInt(process.env.COOLDOWN_MINUTES  || "45", 10);
const RESET_MAGIC        = (process.env.RESET_MAGIC || "oga").toLowerCase();

const GRAPH_BASE = `https://graph.facebook.com/v${GRAPH_VERSION}`;
const GRAPH_URL  = `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`;
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
    console.warn("[Redis] REDIS_URL missing — using in-memory sessions");
  }
} catch {
  useMemory = true;
  console.warn("[Redis] ioredis not available — using in-memory sessions");
}

const mem = new Map(); // session store
const memKeys = new Set(); // cooldown keys (when memory fallback)

// --- session helpers ---
async function sessGet(userId) {
  if (!useMemory && redis) {
    const raw = await redis.get(`s24:sess:${userId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.get(userId) || null;
}
async function sessSet(userId, s) {
  const ttlSec = SESSION_TTL_HOURS * 3600;
  if (!useMemory && redis) {
    await redis.set(`s24:sess:${userId}`, JSON.stringify(s), "EX", ttlSec);
  } else {
    mem.set(userId, s);
    setTimeout(() => mem.delete(userId), ttlSec * 1000).unref?.();
  }
}
async function sessDel(userId) {
  if (!useMemory && redis) await redis.del(`s24:sess:${userId}`);
  mem.delete(userId);
}

// --- cooldown helpers ---
async function coolSet(userId, minutes = COOLDOWN_MINUTES) {
  const key = `s24:cool:${userId}`;
  if (!useMemory && redis) {
    await redis.set(key, "1", "EX", minutes * 60);
  } else {
    memKeys.add(key);
    setTimeout(() => memKeys.delete(key), minutes * 60 * 1000).unref?.();
  }
}
async function coolHas(userId) {
  const key = `s24:cool:${userId}`;
  if (!useMemory && redis) return (await redis.exists(key)) === 1;
  return memKeys.has(key);
}
async function coolDel(userId) {
  const key = `s24:cool:${userId}`;
  if (!useMemory && redis) await redis.del(key);
  memKeys.delete(key);
}

// ===== Static data =====
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

// ===== WhatsApp helpers =====
function postWA(payload) { return axios.post(GRAPH_URL, payload, AUTH); }
function sendText(to, text) {
  return postWA({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}

// UI: start confirm
function sendStartConfirm(to) {
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
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
    to, type: "interactive",
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

// city
function sendCityMenu(to) {
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Selecciona tu ciudad" },
      body:   { text: "Elige la ciudad donde necesitas el servicio:" },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar ciudad",
        sections: [{ title: "Ciudades", rows: CITIES.map(c => ({ id: c.id, title: c.title })) }]
      }
    }
  });
}

// zona groups
function sendZonaGroupButtons(to) {
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
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

// zona list
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body:   { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar zona", sections: [{ title: "Zonas", rows }] }
    }
  });
}

// zona confirm
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
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

// services list + consent
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas que tus datos se compartan con profesionales cercanos y que puedas recibir sus llamadas o mensajes. Sin costo._";
  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body:   { text: `Selecciona el profesional que necesitas:\n${cityTitle} • Zona ${z} ${zEmoji}\n\n${consent}` },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [{ title: "Profesionales", rows: SERVICES.map(s => ({ id: s.id, title: `${s.label} ${s.emoji}` })) }]
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
  return text;
}

// ===== Free-text behavior =====
async function recoverUI(from, s) {
  if (!s.started)         { await sendStartConfirm(from); return; }
  if (!s.city)            { await sendCityMenu(from);     return; }
  if (!s.zone)            { await sendZonaGroupButtons(from); return; }
  if (!s.zoneConfirmed)   { await sendZonaConfirm(from, s.zone); return; }
  const cityTitle = s.city?.title || "Ciudad de Guatemala";
  await sendServicesList(from, cityTitle, s.zone);
}

// ===== Verify =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Receive =====
app.post("/webhook", async (req, res) => {
  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;

    // ensure session
    let s = await sessGet(from);
    if (!s) {
      s = { city:null, zone:null, zoneConfirmed:false, serviceId:null, started:false, state:"MENU", lastConfirmation:null };
      await sessSet(from, s);
    }

    // --- MAGIC RESET: works anytime, clears cooldown too ---
    if (msg.type === "text") {
      const body = (msg.text?.body || "").trim().toLowerCase();
      if (body === RESET_MAGIC) {
        await coolDel(from);
        await sessDel(from);
        const fresh = { city:null, zone:null, zoneConfirmed:false, serviceId:null, started:false, state:"MENU", lastConfirmation:null };
        await sessSet(from, fresh);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }
    }

    // --- DONE state handling with cooldown ---
    if (s.state === "DONE") {
      if (await coolHas(from)) {
        const fallback =
          s.lastConfirmation ||
          `Listo ✅  ${(SERVICES.find(x => x.id === s.serviceId)?.label || "Profesional")} ${(SERVICES.find(x => x.id === s.serviceId)?.emoji || "👤")} • ` +
          `Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")} • ${(s.city?.title || "Ciudad de Guatemala")}.\n` +
          `En breve te contactarán profesionales cercanos.\n\nServicio24`;
        await sendText(from, fallback);
        return res.sendStatus(200);
      } else {
        // cooldown expired → start a fresh flow
        await sessDel(from);
        const fresh = { city:null, zone:null, zoneConfirmed:false, serviceId:null, started:false, state:"MENU", lastConfirmation:null };
        await sessSet(from, fresh);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }
    }

    // --- Regular text (no magic) → show current UI ---
    if (msg.type === "text") {
      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    // list reply
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // city
      if (CITIES.some(c => c.id === id)) {
        const city = CITIES.find(c => c.id === id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.started = true; s.state = "MENU";
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // exact zona
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z >= 1 && z <= 25) {
          s.zone = z; s.zoneConfirmed = false; s.state = "MENU";
          await sessSet(from, s);
          await sendZonaConfirm(from, z);
          return res.sendStatus(200);
        }
      }

      // service
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
        s.lastConfirmation = finalText;
        await sessSet(from, s);
        await coolSet(from); // start cooldown after lead creation
        return res.sendStatus(200);
      }
    }

    // button reply
    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes")  { s.started = true; s.state = "MENU"; await sessSet(from, s); await sendRoleButtons(from); return res.sendStatus(200); }
      if (id === "start_no")   { await sendText(from, "Operación cancelada.\n\nServicio24"); return res.sendStatus(200); }

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

    // fallback if city missing
    if (!s.city) { await sendCityMenu(from); return res.sendStatus(200); }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ===== Health =====
app.get("/", (_req, res) =>
  res.status(200).send("🚀 Servicio24 — V2 Barzel Stable (Redis + Full Emojis + Cooldown + Reset)"),
);

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V2 Barzel Stable]`));
