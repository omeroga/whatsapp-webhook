// index.js — Servicio24 V3.1 Barzel Stable
// Features:
// - Ads + Organic flows (city locked for Ads)
// - Multiline final message (City first, then Zone) with blank lines
// - Urgency question (Sí/No) after service selection
// - Single-use "Gracias" final acknowledgement (no re-sending interactive on ack)
// - Redis sessions (fallback to memory)
// - Full emojis for ZONAS & services
// - Free-text recovery + cooldown + magic reset
// - Structured JSON logging
// - Input validation (city/zone/service/interactive ids)
// - Idempotency (dedupe incoming WhatsApp message IDs)
// - Local rate limiting (per-user)
// - Robust Graph API call with retry+exponential backoff
// - No "Servicio24" inside body texts (only header/footer)
//
// Env (Render):
//   WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, REDIS_URL (optional), GRAPH_VERSION (e.g. "23.0")
//   SESSION_TTL_HOURS, COOLDOWN_MINUTES, RESET_MAGIC
//
// Notes:
// - Keep GRAPH_VERSION without leading "v" (e.g. 23.0) — code adds the "v".
// - If Redis missing, memory fallback is used for sessions, cooldown, idempotency & rate limit.
// - Safe defaults included.

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== Config =====
const GRAPH_VERSION     = process.env.GRAPH_VERSION || "23.0";
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || "6", 10);
const COOLDOWN_MINUTES  = parseInt(process.env.COOLDOWN_MINUTES  || "45", 10);
const RESET_MAGIC       = (process.env.RESET_MAGIC || "oga").toLowerCase();

// Rate limit (per user/phone number)
const RL_MAX_TOKENS     = parseInt(process.env.RL_MAX_TOKENS || "6", 10);   // tokens in bucket
const RL_REFILL_SEC     = parseInt(process.env.RL_REFILL_SEC || "10", 10);  // window seconds

const GRAPH_BASE = `https://graph.facebook.com/v${GRAPH_VERSION}`;
const GRAPH_URL  = `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

if (!process.env.WHATSAPP_TOKEN || !process.env.PHONE_NUMBER_ID) {
  console.error(JSON.stringify({ level:"fatal", evt:"missing_env", at:"boot", missing: ["WHATSAPP_TOKEN","PHONE_NUMBER_ID"] }));
  process.exit(1);
}

// ===== Redis (fallback to memory) =====
let redis = null;
let useMemory = false;
try {
  const Redis = require("ioredis");
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on("connect", () => console.log(JSON.stringify({ level:"info", evt:"redis_connect" })));
    redis.on("error", (e) => {
      console.error(JSON.stringify({ level:"error", evt:"redis_error", msg: e?.message || String(e) }));
      redis = null; useMemory = true;
    });
  } else {
    useMemory = true;
    console.warn(JSON.stringify({ level:"warn", evt:"redis_absent_memory_fallback" }));
  }
} catch {
  useMemory = true;
  console.warn(JSON.stringify({ level:"warn", evt:"redis_module_missing_memory_fallback" }));
}

// ===== In-memory stores (fallbacks) =====
const mem = new Map();       // sessions
const memKeys = new Set();   // cooldown keys
const memIdem = new Set();   // idempotency keys (message_id)
const memRL   = new Map();   // rate limit buckets { tokens, resetAt }

// ===== Utilities =====
const nowSec = () => Math.floor(Date.now()/1000);

// Robust delay
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Graph call with retry & backoff (429/5xx/network)
async function postGraphWithRetry(payload, attempt = 1) {
  const MAX_ATT = 3;
  try {
    return await axios.post(GRAPH_URL, payload, AUTH);
  } catch (err) {
    const status = err?.response?.status;
    const retriable = !status || status === 429 || (status >= 500 && status < 600);
    const info = { level:"error", evt:"graph_post_error", attempt, status, message: err?.message };
    console.error(JSON.stringify(info));

    if (retriable && attempt < MAX_ATT) {
      const backoff = 300 * Math.pow(2, attempt - 1); // 300ms, 600ms
      await delay(backoff);
      return postGraphWithRetry(payload, attempt + 1);
    }
    throw err;
  }
}

// ===== Sessions =====
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

// ===== Cooldown =====
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

// ===== Idempotency (incoming message dedupe) =====
async function idemSeen(messageId) {
  const key = `s24:idem:${messageId}`;
  if (!messageId) return false;
  if (!useMemory && redis) {
    const ok = await redis.set(key, "1", "NX", "EX", 60 * 10); // 10min
    return ok === null; // if set failed => already exists
  } else {
    if (memIdem.has(key)) return true;
    memIdem.add(key);
    setTimeout(() => memIdem.delete(key), 10 * 60 * 1000).unref?.();
    return false;
  }
}

// ===== Rate limit (token bucket per user) =====
async function rlAllow(userId) {
  const key = `s24:rl:${userId}`;
  if (!useMemory && redis) {
    // Sliding bucket using INCR + EXPIRE per window
    const windowKey = `${key}:${Math.floor(nowSec()/RL_REFILL_SEC)}`;
    const cnt = await redis.incr(windowKey);
    if (cnt === 1) await redis.expire(windowKey, RL_REFILL_SEC);
    return cnt <= RL_MAX_TOKENS;
  } else {
    const w = Math.floor(nowSec()/RL_REFILL_SEC);
    const bucket = memRL.get(userId) || { window: w, count: 0 };
    if (bucket.window !== w) { bucket.window = w; bucket.count = 0; }
    bucket.count += 1;
    memRL.set(userId, bucket);
    return bucket.count <= RL_MAX_TOKENS;
  }
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
const SERVICE_NAME_TO_ID = (() => {
  const map = {};
  for (const s of SERVICES) map[s.label.toLowerCase()] = s.id;
  map["plomero"] = "srv_plomero";
  map["electricista"] = "srv_electricista";
  map["cerrajero"] = "srv_cerrajero";
  map["aire"] = "srv_aire";
  map["aire acondicionado"] = "srv_aire";
  map["mecanico"] = "srv_mecanico";
  map["mecánico"] = "srv_mecanico";
  map["grua"] = "srv_grua";
  map["grúa"] = "srv_grua";
  map["mudanza"] = "srv_mudanza";
  return map;
})();

const ZONA_EMOJI = {
  1:"🏛️",2:"🍺",3:"🕊️",4:"💰",5:"🏟️",6:"🏘️",7:"🏺",8:"🚌",9:"🏨",10:"🎉",
  11:"🛒",12:"🧰",13:"✈️",14:"🏢",15:"🎓",16:"🏰",17:"🏭",18:"🛣️",19:"🔧",20:"🏚️",
  21:"🚧",22:"📦",23:"🚋",24:"🏗️",25:"🌳"
};

// ===== WhatsApp helpers (with retry) =====
function postWA(payload) { return postGraphWithRetry(payload); }
function sendText(to, text) {
  return postWA({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });
}
function sendInteractiveButton(to, headerText, bodyText, buttonId, buttonTitle) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: headerText },
      body:   { text: bodyText },
      footer: { text: "Servicio24" },
      action: { buttons: [{ type: "reply", reply: { id: buttonId, title: buttonTitle } }] }
    }
  });
}

// ===== UI blocks =====
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
// Services list — City (blank line) Zone (blank line) + consent
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
      body:   { text:
        `Selecciona el profesional que necesitas:\n\n` +
        `${cityTitle}\n\n` +
        `Zona ${z} ${zEmoji}\n\n` +
        `${consent}`
      },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [{ title: "Profesionales", rows: SERVICES.map(s => ({ id: s.id, title: `${s.label} ${s.emoji}` })) }]
      }
    }
  });
}
function sendUrgencyQuestion(to) {
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Prioridad" },
      body:   { text: "¿El servicio es para ahora?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "urgency_now",   title: "Sí ✅" } },
          { type: "reply", reply: { id: "urgency_later", title: "No ❌" } },
        ],
      },
    },
  });
}
function sendFinalInteractive(to, finalText) {
  return sendInteractiveButton(
    to,
    "Servicio24",
    finalText,
    "final_ack",
    "Gracias 🙏"
  );
}
async function sendLeadReady(to, cityTitle, zone, serviceId) {
  const svc = SERVICES.find(s => s.id === serviceId);
  const serviceText = svc ? `${svc.label} ${svc.emoji}` : "Profesional 👤";
  const zoneEmoji = ZONA_EMOJI[zone] || "";
  const finalText =
    `Listo ✅\n\n` +
    `${serviceText}\n\n` +
    `${cityTitle}\n\n` +
    `Zona ${zone} ${zoneEmoji}\n\n` +
    `En breve te contactarán profesionales cercanos.`;
  await sendFinalInteractive(to, finalText);
  return finalText;
}

// ===== Ads helpers =====
function parseAdParams(rawText) {
  if (!rawText) return null;
  const text = String(rawText).trim();
  const m = text.match(/#ad\s+(.+)$/i);
  if (!m) return null;
  const qs = m[1];

  const params = {};
  qs.split("&").forEach(kv => {
    const [k, v] = kv.split("=").map(x => (x||"").trim());
    if (!k) return;
    params[k.toLowerCase()] = decodeURIComponent((v||"").trim());
  });

  let cityId = params.city || params.ciudad || params.c;
  let zoneStr = params.zone || params.zona || params.z;
  let service = params.service || params.servicio || params.s;

  let serviceId = null;
  if (service) {
    const sv = service.toLowerCase();
    serviceId = SERVICE_LABEL[sv] ? sv : (SERVICE_NAME_TO_ID[sv] || null);
    if (!serviceId && sv.startsWith("srv_")) serviceId = sv;
  }
  const zone = zoneStr ? parseInt(zoneStr, 10) : null;

  let city = null;
  if (cityId) {
    const found = CITIES.find(c => c.id === cityId);
    if (found) city = found;
  }
  if (!city) city = CITIES[0];

  return {
    city,
    zone: (zone && zone >=1 && zone <=25) ? zone : null,
    serviceId: (serviceId && SERVICE_LABEL[serviceId]) ? serviceId : null
  };
}
function sendAdConfirm(to, cityTitle, zone, serviceId) {
  const svc = SERVICES.find(s => s.id === serviceId);
  const svcText = svc ? `${svc.label} ${svc.emoji}` : "Profesional 👤";
  const zEmoji = ZONA_EMOJI[zone] || "";
  const body =
    `¿Buscas *${svcText}* en *${cityTitle}*?\n` +
    `Zona ${zone} ${zEmoji}`;
  return postWA({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Confirmación" },
      body:   { text: body },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "ad_yes",    title: "Sí ✅" } },
          { type: "reply", reply: { id: "ad_change", title: "Cambiar 🔄" } },
        ]
      }
    }
  });
}

// ===== Flow recovery =====
async function recoverUI(from, s) {
  if (!s.started) { await sendStartConfirm(from); return; }

  if (s.source === "ad") {
    if (!s.zone)          { await sendZonaGroupButtons(from); return; }
    if (!s.zoneConfirmed) { await sendZonaConfirm(from, s.zone); return; }
    if (!s.serviceId)     {
      const cityTitle = s.city?.title || "Ciudad de Guatemala";
      await sendServicesList(from, cityTitle, s.zone);
      return;
    }
    if (!s.urgency)       { await sendUrgencyQuestion(from); return; }
  }

  if (!s.city)            { await sendCityMenu(from); return; }
  if (!s.zone)            { await sendZonaGroupButtons(from); return; }
  if (!s.zoneConfirmed)   { await sendZonaConfirm(from, s.zone); return; }
  if (s.serviceId && !s.urgency) { await sendUrgencyQuestion(from); return; }

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
  const reqStart = Date.now();
  try {
    const entry  = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const msg    = value?.messages?.[0];
    const msgId  = msg?.id || msg?.key?.id || null;
    const from   = msg?.from;

    // Idempotency: drop repeats
    if (msgId) {
      const already = await idemSeen(msgId);
      if (already) {
        console.log(JSON.stringify({ level:"info", evt:"idem_skip", msgId, from }));
        return res.sendStatus(200);
      }
    }

    // Basic validation
    if (!from || !msg) {
      console.warn(JSON.stringify({ level:"warn", evt:"no_message_or_from" }));
      return res.sendStatus(200);
    }

    // Rate limit per user
    const allowed = await rlAllow(from);
    if (!allowed) {
      console.warn(JSON.stringify({ level:"warn", evt:"rate_limited", from }));
      try {
        await sendText(from, "Estamos recibiendo varios mensajes. Por favor, intenta de nuevo en unos segundos 🙏");
      } catch {}
      return res.sendStatus(200);
    }

    // ensure session
    let s = await sessGet(from);
    if (!s) {
      s = {
        city:null, zone:null, zoneConfirmed:false, serviceId:null,
        urgency:null, started:false, state:"MENU", lastConfirmation:null, finalAcked:false,
        source:null, adLockCity:false
      };
      await sessSet(from, s);
    }

    // MAGIC RESET
    if (msg.type === "text") {
      const bodyRaw = (msg.text?.body || "");
      const lower = bodyRaw.trim().toLowerCase();

      if (lower === RESET_MAGIC) {
        await coolDel(from);
        await sessDel(from);
        const fresh = {
          city:null, zone:null, zoneConfirmed:false, serviceId:null,
          urgency:null, started:false, state:"MENU", lastConfirmation:null, finalAcked:false,
          source:null, adLockCity:false
        };
        await sessSet(from, fresh);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }

      // Detect Ads prefill
      if (!s.started) {
        const ad = parseAdParams(bodyRaw);
        if (ad && ad.city && ad.zone && ad.serviceId) {
          s.started = true;
          s.source = "ad";
          s.adLockCity = true;
          s.city = ad.city;
          s.zone = ad.zone;
          s.zoneConfirmed = true;
          s.serviceId = ad.serviceId;
          s.urgency = null;
          s.state = "MENU";
          s.finalAcked = false;
          await sessSet(from, s);
          await sendAdConfirm(from, s.city.title, s.zone, s.serviceId);
          return res.sendStatus(200);
        }
      }

      // DONE & cooldown echo handling
      if (s.state === "DONE") {
        if (await coolHas(from)) {
          if (s.finalAcked) return res.sendStatus(200);
          // DO NOT re-send interactive to keep button greyed — send nothing / or a short text if needed
          s.finalAcked = true;
          await sessSet(from, s);
          try { await sendText(from, "Gracias 🙏"); } catch {}
          return res.sendStatus(200);
        } else {
          // fresh start
          await sessDel(from);
          const fresh = {
            city:null, zone:null, zoneConfirmed:false, serviceId:null,
            urgency:null, started:false, state:"MENU", lastConfirmation:null, finalAcked:false,
            source:null, adLockCity:false
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return res.sendStatus(200);
        }
      }

      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    // list reply
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // City chosen
      if (CITIES.some(c => c.id === id)) {
        if (s.adLockCity) { await sendZonaGroupButtons(from); return res.sendStatus(200); }
        const city = CITIES.find(c => c.id === id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
        s.started = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // Zone chosen
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (Number.isFinite(z) && z >= 1 && z <= 25) {
          s.zone = z; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
          s.state = "MENU"; s.finalAcked = false;
          await sessSet(from, s);
          await sendZonaConfirm(from, z);
          return res.sendStatus(200);
        } else {
          console.warn(JSON.stringify({ level:"warn", evt:"zone_invalid", id }));
          await sendText(from, "Zona inválida. Elige una zona entre 1 y 25.");
          return res.sendStatus(200);
        }
      }

      // Service chosen
      if (SERVICE_LABEL[id]) {
        if (!s.zoneConfirmed) {
          await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
          await sendZonaGroupButtons(from);
          return res.sendStatus(200);
        }
        s.serviceId = id;
        s.urgency = null;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }

      // Unknown list id
      console.warn(JSON.stringify({ level:"warn", evt:"unknown_list_id", id }));
      return res.sendStatus(200);
    }

    // button reply
    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes")  { s.started = true; s.state = "MENU"; s.finalAcked = false; await sessSet(from, s); await sendRoleButtons(from); return res.sendStatus(200); }
      if (id === "start_no")   { await sendText(from, "Operación cancelada.\n\nServicio24"); return res.sendStatus(200); }

      if (id === "role_cliente") { s.finalAcked = false; await sessSet(from, s); s.adLockCity ? await sendZonaGroupButtons(from) : await sendCityMenu(from); return res.sendStatus(200); }
      if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24"); return res.sendStatus(200); }

      if (id === "zona_group_1_10")  { s.finalAcked = false; await sessSet(from, s); await sendZonaList(from, 1, 10);  return res.sendStatus(200); }
      if (id === "zona_group_11_20") { s.finalAcked = false; await sessSet(from, s); await sendZonaList(from, 11, 20); return res.sendStatus(200); }
      if (id === "zona_group_21_25") { s.finalAcked = false; await sessSet(from, s); await sendZonaList(from, 21, 25); return res.sendStatus(200); }

      if (id === "zona_change") {
        s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s); await sendZonaGroupButtons(from); return res.sendStatus(200);
      }
      if (id === "zona_confirm") {
        if (!s.zone || !(s.zone >=1 && s.zone <=25)) { await sendZonaGroupButtons(from); return res.sendStatus(200); }
        s.zoneConfirmed = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendServicesList(from, cityTitle, s.zone);
        return res.sendStatus(200);
      }

      // Ads confirm
      if (id === "ad_yes") {
        s.started = true; s.state = "MENU"; s.zoneConfirmed = true; s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }
      if (id === "ad_change") {
        s.state = "MENU"; s.serviceId = null; s.urgency = null; s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // Urgency
      if (id === "urgency_now" || id === "urgency_later") {
        s.urgency = (id === "urgency_now") ? "now" : "later";
        await sessSet(from, s);

        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);

        s.state = "DONE";
        s.lastConfirmation = finalText;
        s.finalAcked = false;     // allow one final *echo* only if needed (but we won't re-send interactive)
        await sessSet(from, s);
        await coolSet(from);
        return res.sendStatus(200);
      }

      // Final ack — SINGLE USE: do not send interactive again
      if (id === "final_ack") {
        if (await coolHas(from)) {
          if (s.finalAcked) return res.sendStatus(200);
          s.finalAcked = true;
          await sessSet(from, s);
          try { await sendText(from, "Gracias 🙏"); } catch {}
          return res.sendStatus(200);
        } else {
          await sessDel(from);
          const fresh = {
            city:null, zone:null, zoneConfirmed:false, serviceId:null,
            urgency:null, started:false, state:"MENU", lastConfirmation:null, finalAcked:false,
            source:null, adLockCity:false
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return res.sendStatus(200);
        }
      }

      // Unknown button id
      console.warn(JSON.stringify({ level:"warn", evt:"unknown_button_id", id }));
      return res.sendStatus(200);
    }

    // Fallback if city missing (respect ad lock)
    if (!s.city) {
      if (s.adLockCity && s.city) {
        await sendZonaGroupButtons(from);
      } else {
        await sendCityMenu(from);
      }
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error(JSON.stringify({ level:"error", evt:"webhook_exception", message: err?.message, stack: err?.stack }));
    // Graceful error to user if we can
    try {
      const from = req?.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) await sendText(from, "Tenemos un problema temporal. Intenta nuevamente más tarde 🙏");
    } catch {}
    return res.sendStatus(200);
  } finally {
    const ms = Date.now() - reqStart;
    console.log(JSON.stringify({ level:"info", evt:"req_done", ms }));
  }
});

// ===== Health =====
app.get("/", (_req, res) =>
  res.status(200).send("🚀 Servicio24 — V3.1 Barzel Stable (Ads+Organic + Redis + Emojis + Cooldown + Reset + Urgency + Gracias single-use + Validation + Idempotency + Retry + RateLimit)"),
);

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(JSON.stringify({ level:"info", evt:"server_start", port: PORT, tag: "V3.1" })));
