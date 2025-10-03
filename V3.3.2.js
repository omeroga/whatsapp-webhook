/**
 * Servicio24 - V3.3.2 Stable
 * Full WhatsApp LeadGen flow - Ads prefill + Regex free-text + Lead routing + Security
 *
 * Set up - install deps:
 * npm i express axios pino crypto express-rate-limit @supabase/supabase-js ioredis bullmq envalid
 *
 * Optional (only if you want): npm i joi
 *
 * Env needed:
 *  - WHATSAPP_TOKEN
 *  - PHONE_NUMBER_ID
 *  - VERIFY_TOKEN
 *  - APP_SECRET                        // for HMAC signature verification
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - REDIS_URL                         // optional - enables Redis sessions and BullMQ queue
 *  - LOG_LEVEL=info|debug              // default info
 *  - SESSION_TTL_HOURS=6               // default 6
 *  - COOLDOWN_MINUTES=45               // default 45
 *  - GRAPH_VERSION=23.0                // default 23.0
 *  - RESET_MAGIC=oga                   // default "oga"
 *  - ADMIN_PHONE                       // optional - alerts on critical failures
 *  - SQLITE_PATH                       // optional - not used for now, kept for future fallback
 */

const express = require("express");
const axios = require("axios");
const pino = require("pino");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

// envalid - env validation (soft-fail if not installed)
let cleanEnv = null, str = null, num = null;
try {
  const ev = require("envalid");
  cleanEnv = ev.cleanEnv;
  str = ev.str;
  num = ev.num;
} catch (_) {
  // fallback - minimal manual guard
}

// ===== Logger =====
const log = pino({ level: process.env.LOG_LEVEL || "info" });

// ===== App =====
const app = express();

// capture raw body for HMAC validation
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// ===== Rate limiting (basic - 100 req/min per IP to /webhook) =====
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/webhook", limiter);

// ===== Env validation =====
let ENV = null;
if (cleanEnv) {
  ENV = cleanEnv(process.env, {
    WHATSAPP_TOKEN: str(),
    PHONE_NUMBER_ID: str(),
    VERIFY_TOKEN: str(),
    APP_SECRET: str(),
    SUPABASE_URL: str(),
    SUPABASE_SERVICE_KEY: str(),
    GRAPH_VERSION: str({ default: "23.0" }),
    SESSION_TTL_HOURS: num({ default: 6 }),
    COOLDOWN_MINUTES: num({ default: 45 }),
    RESET_MAGIC: str({ default: "oga" }),
    REDIS_URL: str({ default: "" }),
    ADMIN_PHONE: str({ default: "" }),
  });
} else {
  const missing = [];
  ["WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "VERIFY_TOKEN", "APP_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"].forEach(k=>{
    if (!process.env[k]) missing.push(k);
  });
  if (missing.length) {
    log.error({ missing }, "Missing required env vars");
    process.exit(1);
  }
  ENV = {
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    VERIFY_TOKEN: process.env.VERIFY_TOKEN,
    APP_SECRET: process.env.APP_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    GRAPH_VERSION: process.env.GRAPH_VERSION || "23.0",
    SESSION_TTL_HOURS: parseInt(process.env.SESSION_TTL_HOURS || "6", 10),
    COOLDOWN_MINUTES: parseInt(process.env.COOLDOWN_MINUTES || "45", 10),
    RESET_MAGIC: (process.env.RESET_MAGIC || "oga").toLowerCase(),
    REDIS_URL: process.env.REDIS_URL || "",
    ADMIN_PHONE: process.env.ADMIN_PHONE || "",
  };
}

// ===== Supabase client =====
let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY);
  log.info("[Supabase] client initialized");
} catch (e) {
  log.error({ err: e?.message || e }, "[Supabase] init failed");
  process.exit(1);
}

// ===== Redis + Queue (BullMQ) - optional =====
let redis = null, useMemory = false, Queue = null, Worker = null, waQueue = null;
try {
  if (ENV.REDIS_URL) {
    const Redis = require("ioredis");
    redis = new Redis(ENV.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
    redis.on("connect", () => log.info("[Redis] connected"));
    redis.on("error", (e) => {
      log.error({ err: e?.message || e }, "[Redis] error - switching to memory");
      redis = null;
      useMemory = true;
    });

    const bullmq = require("bullmq");
    Queue = bullmq.Queue;
    Worker = bullmq.Worker;
    waQueue = new Queue("wa-messages", { connection: { url: ENV.REDIS_URL } });

    // Simple worker - send messages with backoff
    new Worker("wa-messages", async job => {
      try {
        await postWA(job.data.payload);
        return true;
      } catch (err) {
        log.error({ err: err?.response?.data || err?.message || err }, "[WA-Queue] send error");
        throw err;
      }
    }, { connection: { url: ENV.REDIS_URL }, concurrency: 5, autorun: true });

    log.info("[Queue] BullMQ worker started");
  } else {
    useMemory = true;
    log.warn("[Redis] REDIS_URL missing - using memory sessions and direct send");
  }
} catch (e) {
  useMemory = true;
  log.warn("[Redis/BullMQ] not available - using memory and direct send");
}

// ===== Config =====
const GRAPH_VERSION = ENV.GRAPH_VERSION;
const SESSION_TTL_HOURS = ENV.SESSION_TTL_HOURS;
const COOLDOWN_MINUTES = ENV.COOLDOWN_MINUTES;
const RESET_MAGIC = ENV.RESET_MAGIC;

const GRAPH_BASE = `https://graph.facebook.com/v${GRAPH_VERSION}`;
const GRAPH_URL = `${GRAPH_BASE}/${ENV.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${ENV.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// ===== Memory stores (fallbacks) =====
const mem = new Map();     // user sessions
const memCool = new Set(); // cooldown keys

// backups for leads when supabase fails
const fs = require("fs");
const path = require("path");
const BACKUP_FILE = path.join(process.env.TMPDIR || "/tmp", "s24_leads_backup.jsonl");

// ===== Static Data =====
const CITIES = [
  { id: "city_guatemala", title: "Ciudad de Guatemala" },
  // future:
  // { id: "city_quetzaltenango", title: "Quetzaltenango" },
];

const SERVICES = [
  { id: "srv_plomero", label: "Plomero", emoji: "🚰" },
  { id: "srv_electricista", label: "Electricista", emoji: "⚡" },
  { id: "srv_cerrajero", label: "Cerrajero", emoji: "🔑" },
  { id: "srv_aire", label: "Aire acondicionado", emoji: "❄️" },
  { id: "srv_mecanico", label: "Mecánico", emoji: "🛠️" },
  { id: "srv_grua", label: "Servicio de grúa", emoji: "🛻" },
  { id: "srv_mudanza", label: "Mudanza", emoji: "🚚" },
];

const SERVICE_LABEL = Object.fromEntries(SERVICES.map((s) => [s.id, s.label]));
const SERVICE_NAME_TO_ID = (() => {
  const map = {};
  for (const s of SERVICES) map[s.label.toLowerCase()] = s.id;
  // synonyms
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
  21:"🚧",22:"📦",23:"🚋",24:"🏗️",25:"🌳",
};

// ===== Helpers - Sessions =====
async function sessGet(userId){
  if (redis && !useMemory) {
    const raw = await redis.get(`s24:sess:${userId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return mem.get(userId) || null;
}
async function sessSet(userId, s){
  const ttlSec = SESSION_TTL_HOURS * 3600;
  if (redis && !useMemory) {
    await redis.set(`s24:sess:${userId}`, JSON.stringify(s), "EX", ttlSec);
  } else {
    mem.set(userId, s);
    setTimeout(()=>mem.delete(userId), ttlSec*1000).unref?.();
  }
}
async function sessDel(userId){
  if (redis && !useMemory) await redis.del(`s24:sess:${userId}`);
  mem.delete(userId);
}

// ===== Helpers - Cooldown =====
async function coolSet(userId, minutes = COOLDOWN_MINUTES) {
  const k = `s24:cool:${userId}`;
  if (redis && !useMemory) {
    await redis.set(k, "1", "EX", minutes * 60);
  } else {
    memCool.add(k);
    setTimeout(()=>memCool.delete(k), minutes*60*1000).unref?.();
  }
}
async function coolHas(userId){
  const k = `s24:cool:${userId}`;
  if (redis && !useMemory) return (await redis.exists(k)) === 1;
  return memCool.has(k);
}
async function coolDel(userId){
  const k = `s24:cool:${userId}`;
  if (redis && !useMemory) await redis.del(k);
  memCool.delete(k);
}

// ===== WhatsApp send helpers with optional Queue =====
function postWA(payload) {
  return axios.post(GRAPH_URL, payload, AUTH);
}
async function sendPayload(payload) {
  if (waQueue) {
    await waQueue.add("send", { payload }, { attempts: 3, backoff: { type: "exponential", delay: 1500 } });
  } else {
    await postWA(payload);
  }
}
function sendText(to, text){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}
function sendInteractiveButton(to, headerText, bodyText, buttonId, buttonTitle){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: headerText },
      body: { text: bodyText },
      footer: { text: "Servicio24" },
      action: { buttons: [{ type: "reply", reply: { id: buttonId, title: buttonTitle } }] },
    },
  });
}
function sendStartConfirm(to){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Servicio24" },
      body: { text: "¿Deseas iniciar tu solicitud?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "start_yes", title: "Confirmar" } },
          { type: "reply", reply: { id: "start_no", title: "Cancelar" } },
        ],
      },
    },
  });
}
function sendRoleButtons(to){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Bienvenido a Servicio24" },
      body: { text: "*Selecciona tu rol:*" },
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
function sendCityMenu(to){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Selecciona tu ciudad" },
      body: { text: "Elige la ciudad donde necesitas el servicio:" },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar ciudad",
        sections: [
          { title: "Ciudades", rows: CITIES.map((c)=>({ id: c.id, title: c.title })) }
        ],
      },
    },
  });
}
function sendZonaGroupButtons(to){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Zonas" },
      body: { text: "Selecciona tu zona:" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "zona_group_1_10", title: "Zonas 1-10" } },
          { type: "reply", reply: { id: "zona_group_11_20", title: "Zonas 11-20" } },
          { type: "reply", reply: { id: "zona_group_21_25", title: "Zonas 21-25" } },
        ],
      },
    },
  });
}
function sendZonaList(to, start, end){
  const rows = [];
  for (let z = start; z <= end; z++) rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body: { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar zona", sections: [{ title: "Zonas", rows }] },
    },
  });
}
function sendZonaConfirm(to, z){
  const emoji = ZONA_EMOJI[z] || "";
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: `Zona seleccionada: ${z} ${emoji}` },
      body: { text: "¿Desea continuar con esta zona?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "zona_confirm", title: "Confirmar" } },
          { type: "reply", reply: { id: "zona_change", title: "Cambiar zona" } },
        ],
      },
    },
  });
}
function sendServicesList(to, cityTitle, z){
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas que tus datos se compartan con profesionales cercanos y que puedas recibir sus llamadas o mensajes. Sin costo._";
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body: { text: `Selecciona el profesional que necesitas:\n\n${cityTitle}\n\nZona ${z} ${zEmoji}\n\n${consent}` },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [
          { title: "Profesionales", rows: SERVICES.map((s)=>({ id: s.id, title: `${s.label} ${s.emoji}` })) }
        ],
      },
    },
  });
}
function sendUrgencyQuestion(to){
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Prioridad" },
      body: { text: "¿El servicio es para ahora?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "urgency_now", title: "Sí ✅" } },
          { type: "reply", reply: { id: "urgency_later", title: "No ❌" } },
        ],
      },
    },
  });
}
function sendFinalInteractive(to, finalText){
  return sendInteractiveButton(to, "Servicio24", finalText, "final_ack", "Confirmar ✅");
}
async function sendLeadReady(to, cityTitle, zone, serviceId){
  const svc = SERVICES.find((s)=>s.id === serviceId);
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

// ===== Ads prefill parsing (+ strict validation) =====
function parseAdParams(rawText) {
  if (!rawText) return null;
  const text = String(rawText).trim();
  const m = text.match(/#ad\s+(.+)$/i);
  if (!m) return null;
  const qs = m[1];

  const params = {};
  qs.split("&").forEach(kv=>{
    const [k,v] = kv.split("=").map((x)=>(x||"").trim());
    if (!k) return;
    params[k.toLowerCase()] = decodeURIComponent((v||"").trim());
  });

  let cityId = params.city || params.ciudad || params.c;
  let zoneStr = params.zone || params.zona || params.z;
  let service = params.service || params.servicio || params.s;
  let lang = params.lang || "es";
  let campaign_id = params.cid || params.campaign || null;

  // normalize service
  let serviceId = null;
  if (service) {
    const sv = String(service).toLowerCase();
    serviceId = SERVICE_LABEL[sv] ? sv : SERVICE_NAME_TO_ID[sv] || null;
    if (!serviceId && sv.startsWith("srv_")) serviceId = sv;
  }

  let zone = null;
  if (zoneStr) {
    const zz = parseInt(zoneStr, 10);
    if (!isNaN(zz) && zz >= 1 && zz <= 25) zone = zz;
    else {
      log.warn({ zoneStr }, "[Ads] invalid zone parameter");
      zone = null;
    }
  }

  // normalize city - default Guatemala City
  let city = null;
  if (cityId) {
    city = CITIES.find((c)=>c.id === cityId) || null;
  }
  if (!city) city = CITIES[0];

  // strict service check
  if (serviceId && !SERVICE_LABEL[serviceId]) {
    log.warn({ service }, "[Ads] invalid service parameter");
    serviceId = null;
  }

  const langNorm = ["es","en"].includes((lang||"").toLowerCase()) ? lang.toLowerCase() : "es";

  return {
    city,
    zone,
    serviceId,
    lang: langNorm,
    campaign_id: campaign_id || null,
  };
}

// ===== HMAC verification middleware for POST /webhook =====
function verifyHmac(req, res, next) {
  const sig = req.get("x-hub-signature-256");
  if (!sig) {
    log.warn("Missing x-hub-signature-256");
    return res.sendStatus(403);
  }
  try {
    const h = crypto.createHmac("sha256", ENV.APP_SECRET);
    h.update(req.rawBody);
    const expected = "sha256=" + h.digest("hex");
    if (sig !== expected) {
      log.warn({ sig, expected }, "Invalid HMAC signature");
      return res.sendStatus(403);
    }
    next();
  } catch (e) {
    log.error({ err: e?.message || e }, "HMAC verify failed");
    return res.sendStatus(403);
  }
}

// ===== Basic schema guard (lightweight) =====
function safeGetMessage(body) {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    return { entry, change, value, msg };
  } catch (_) {
    return {};
  }
}

// ===== Lead persistence with backup and metrics =====
async function saveLeadToSupabase({ phone, city, zona, service, urgency, lang, campaign_id, lead_score }) {
  const start = Date.now();
  let ok = false;
  try {
    if (!supabase) throw new Error("Supabase not ready");
    const { error } = await supabase.from("leads")
      .insert([{ phone, city, zona, service, urgency, lang, campaign_id, lead_score: lead_score ?? null }]);
    if (error) throw new Error(error.message);
    ok = true;
    log.info({ phone, zona, service, took_ms: Date.now()-start }, "[Lead] saved");
  } catch (e) {
    log.error({ err: e?.message || e }, "[Supabase] insert error - backing up locally");
    try {
      const line = JSON.stringify({ ts: Date.now(), phone, city, zona, service, urgency, lang, campaign_id, lead_score }) + "\n";
      fs.appendFileSync(BACKUP_FILE, line);
      ok = false;
    } catch (w) {
      log.error({ err: w?.message || w }, "[Backup] failed");
    }
    // alert admin if configured
    if (ENV.ADMIN_PHONE) {
      await sendText(ENV.ADMIN_PHONE, `⚠️ Lead save failed for ${phone} - ${service} zona ${zona}`);
    }
  }
  return ok;
}

// ===== Lead routing - very simple v1 =====
// Requires table "technicians": columns - id, phone, service_id, zona, rating (optional), active (bool)
async function pickSuppliers(lead) {
  try {
    const serviceId = SERVICE_NAME_TO_ID[(lead.service||"").toLowerCase()] || Object.entries(SERVICE_LABEL).find(([,label])=>label===lead.service)?.[0] || null;
    if (!serviceId) return [];

    const { data: techs, error } = await supabase
      .from("technicians")
      .select("*")
      .eq("service_id", serviceId)
      .eq("active", true)
      .limit(50);

    if (error) {
      log.warn({ err: error.message }, "[pickSuppliers] query error");
      return [];
    }
    if (!techs || techs.length === 0) return [];

    // simple prioritization - exact zone first, then nearby +-1
    const exact = techs.filter(t => Number(t.zona) === Number(lead.zona));
    const near = techs.filter(t => Math.abs(Number(t.zona) - Number(lead.zona)) === 1);

    const ordered = [...exact, ...near, ...techs].filter((t, idx, arr)=>arr.findIndex(x=>x.id===t.id)===idx);
    const top = ordered.slice(0, 3); // send to 3 techs max

    for (const t of top) {
      try {
        await sendText(String(t.phone), `🔔 Nuevo lead: ${lead.service} en Zona ${lead.zona}\n📞 Cliente: ${lead.phone}\n📍 ${lead.city}\n⏱️ ${lead.urgency || ""}`);
        // optional: log link table
        await supabase.from("lead_tech_links").insert([{ lead_phone: lead.phone, tech_id: t.id }]).catch(()=>{});
      } catch (e) {
        log.warn({ err: e?.message || e }, "[pickSuppliers] notify tech failed");
      }
    }
    return top.map(t=>t.id);
  } catch (e) {
    log.error({ err: e?.message || e }, "[pickSuppliers] unexpected");
    return [];
  }
}

// ===== Regex free-text parser (lite) =====
function parseFreeTextToLeadParts(text) {
  const t = (text||"").toLowerCase();

  // service
  let serviceId = null;
  for (const s of SERVICES) {
    const name = s.label.toLowerCase();
    if (t.includes(name)) { serviceId = s.id; break; }
  }
  // synonyms quick pass
  if (!serviceId) {
    for (const [k,v] of Object.entries(SERVICE_NAME_TO_ID)) {
      if (t.includes(k)) { serviceId = v; break; }
    }
  }

  // zona
  let zona = null;
  const m = t.match(/zona\s*([0-9]{1,2})/);
  if (m) {
    const z = parseInt(m[1], 10);
    if (!isNaN(z) && z>=1 && z<=25) zona = z;
  }

  // urgency
  let urgency = null;
  if (/\burgente\b|\bahora\b|\bya\b/.test(t)) urgency = "Ahora";
  if (!urgency && /\bno urgente\b|\bdespues\b|\bdespués\b|\bluego\b/.test(t)) urgency = "Luego";

  return { serviceId, zona, urgency };
}

// ===== Ad confirm UI =====
function sendAdConfirm(to, cityTitle, zone, serviceId){
  const svc = SERVICES.find((s)=>s.id===serviceId);
  const svcText = svc ? `${svc.label} ${svc.emoji}` : "Profesional 👤";
  const zEmoji = ZONA_EMOJI[zone] || "";
  const body = `¿Buscas *${svcText}* en *${cityTitle}*?\nZona ${zone} ${zEmoji}`;
  return sendPayload({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Confirmación" },
      body: { text: body },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "ad_yes", title: "Sí ✅" } },
          { type: "reply", reply: { id: "ad_change", title: "Cambiar 🔄" } },
        ],
      },
    },
  });
}

// ===== Health =====
app.get("/", (_req, res)=>res.status(200).send("🚀 Servicio24 — V3.3.2 Stable (Security + Regex + Routing + Queue + Supabase)"));
// Graph API version health check - best effort
app.get("/health/graph", async (_req, res)=>{
  try {
    const r = await axios.get(GRAPH_BASE);
    return res.status(200).json({ ok: true, status: r.status });
  } catch (e) {
    log.warn({ err: e?.message || e }, "Graph check failed");
    return res.status(500).json({ ok:false });
  }
});

// ===== Verify (GET) =====
app.get("/webhook", (req,res)=>{
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === ENV.VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Receive (POST) with HMAC verify =====
app.post("/webhook", verifyHmac, async (req, res)=>{
  // log raw webhook - only in debug
  if (log.level === "debug") log.debug({ webhook: req.body }, "webhook_raw");

  // best-effort parse
  const { value, msg } = safeGetMessage(req.body);

  // always 200 to Meta
  const done = ()=>res.sendStatus(200);

  try {
    // no message - ack ok
    if (!msg) return done();

    const from = msg.from;
    // ensure session
    let s = await sessGet(from);
    if (!s) {
      s = {
        city: null, zone: null, zoneConfirmed: false,
        serviceId: null, urgency: null,
        started: false, state: "MENU", lastConfirmation: null,
        finalAcked: false, source: null, adLockCity: false,
        lang: "es", campaign_id: null,
        role: "cliente", // or "tecnico"
        pendingConfirm: null, // for regex - {serviceId, zona, urgency}
      };
      await sessSet(from, s);
    }

    // ===== Reset magic
    if (msg.type === "text") {
      const bodyRaw = msg.text?.body || "";
      const body = bodyRaw.trim().toLowerCase();

      if (body === RESET_MAGIC) {
        await coolDel(from);
        await sessDel(from);
        const fresh = {
          city: null, zone: null, zoneConfirmed: false,
          serviceId: null, urgency: null,
          started: false, state: "MENU", lastConfirmation: null,
          finalAcked: false, source: null, adLockCity: false,
          lang: "es", campaign_id: null, role: "cliente", pendingConfirm: null,
        };
        await sessSet(from, fresh);
        await sendStartConfirm(from);
        return done();
      }

      // first text - try Ads prefill
      if (!s.started) {
        const ad = parseAdParams(bodyRaw);
        if (ad && ad.city && ad.zone && ad.serviceId) {
          s.started = true; s.source = "ad"; s.adLockCity = true;
          s.city = ad.city; s.zone = ad.zone; s.zoneConfirmed = true;
          s.serviceId = ad.serviceId; s.urgency = null; s.state = "MENU";
          s.finalAcked = false; s.lang = ad.lang || "es"; s.campaign_id = ad.campaign_id || null;
          await sessSet(from, s);
          await sendAdConfirm(from, s.city.title, s.zone, s.serviceId);
          return done();
        }
      }

      // if state DONE - cooling behavior
      if (s.state === "DONE") {
        if (await coolHas(from)) {
          if (s.finalAcked) return done();
          const fallback =
            s.lastConfirmation ||
            `Listo ✅\n\n${(SERVICES.find((x)=>x.id===s.serviceId)?.label || "Profesional")} ${(SERVICES.find((x)=>x.id===s.serviceId)?.emoji || "👤")}\n\n${s.city?.title || "Ciudad de Guatemala"}\n\nZona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")}\n\nEn breve te contactarán profesionales cercanos.`;
          await sendFinalInteractive(from, fallback);
          s.finalAcked = true;
          await sessSet(from, s);
          return done();
        } else {
          await sessDel(from);
          const fresh = {
            city: null, zone: null, zoneConfirmed: false,
            serviceId: null, urgency: null,
            started: false, state: "MENU", lastConfirmation: null,
            finalAcked: false, source: null, adLockCity: false,
            lang: "es", campaign_id: null, role: "cliente", pendingConfirm: null,
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return done();
        }
      }

      // ===== Regex free-text intake - propose confirmation
      const parts = parseFreeTextToLeadParts(bodyRaw);
      if (parts.serviceId || parts.zona || parts.urgency) {
        s.pendingConfirm = {
          serviceId: parts.serviceId || s.serviceId,
          zona: parts.zona || s.zone,
          urgency: parts.urgency || s.urgency,
        };
        // if missing critical piece - ask minimal follow up
        if (!s.pendingConfirm.serviceId) {
          await sendText(from, "¿Qué servicio necesitas? Escribe por ejemplo: plomero / electricista / cerrajero.");
          await sessSet(from, s);
          return done();
        }
        if (!s.pendingConfirm.zona) {
          await sendText(from, "¿En qué zona estás? Escribe por ejemplo: zona 10.");
          await sessSet(from, s);
          return done();
        }
        if (!s.pendingConfirm.urgency) {
          await sendUrgencyQuestion(from);
          await sessSet(from, s);
          return done();
        }

        // build confirm card
        const svc = SERVICES.find(x=>x.id===s.pendingConfirm.serviceId);
        const zEmoji = ZONA_EMOJI[s.pendingConfirm.zona] || "";
        const confirmBody =
          `Revisar:\n` +
          `${svc ? `${svc.label} ${svc.emoji}` : "Profesional"}\n` +
          `Zona ${s.pendingConfirm.zona} ${zEmoji}\n` +
          `${s.pendingConfirm.urgency === "Ahora" ? "Urgente ⚡" : "Para luego 🕒"}`;
        await sendPayload({
          messaging_product: "whatsapp",
          to: from,
          type: "interactive",
          interactive: {
            type: "button",
            header: { type: "text", text: "Confirmación" },
            body: { text: confirmBody },
            footer: { text: "Servicio24" },
            action: {
              buttons: [
                { type: "reply", reply: { id: "regex_confirm", title: "Confirmar ✅" } },
                { type: "reply", reply: { id: "regex_change", title: "Cambiar 🔄" } },
              ],
            },
          },
        });
        await sessSet(from, s);
        return done();
      }

      // Fallback - recover UI
      await recoverUI(from, s);
      return done();
    }

    const interactive = msg.interactive;

    // list reply
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // city (only if not ad-locked)
      if (CITIES.some((c)=>c.id===id)) {
        if (s.adLockCity) {
          await sendZonaGroupButtons(from);
          return done();
        }
        const city = CITIES.find((c)=>c.id===id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
        s.started = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return done();
      }

      // exact zona
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z>=1 && z<=25) {
          s.zone = z; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
          s.state = "MENU"; s.finalAcked = false;
          await sessSet(from, s);
          await sendZonaConfirm(from, z);
          return done();
        }
      }

      // service
      if (SERVICE_LABEL[id]) {
        if (!s.zoneConfirmed) {
          await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
          await sendZonaGroupButtons(from);
          return done();
        }
        s.serviceId = id; s.urgency = null; s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return done();
      }
    }

    // button reply
    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes") {
        s.started = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        await sendRoleButtons(from);
        return done();
      }
      if (id === "start_no") {
        await sendText(from, "Operación cancelada.\n\nServicio24");
        return done();
      }

      if (id === "role_cliente") {
        s.role = "cliente"; s.finalAcked = false; await sessSet(from, s);
        s.adLockCity ? await sendZonaGroupButtons(from) : await sendCityMenu(from);
        return done();
      }
      if (id === "role_tecnico") {
        s.role = "tecnico"; s.finalAcked = false; await sessSet(from, s);
        // Minimal technician onboarding - choose service first
        await sendPayload({
          messaging_product: "whatsapp",
          to: from,
          type: "interactive",
          interactive: {
            type: "list",
            header: { type: "text", text: "Registro de Técnico" },
            body: { text: "Selecciona tu servicio:" },
            footer: { text: "Servicio24" },
            action: {
              button: "Elegir servicio",
              sections: [{ title: "Servicios", rows: SERVICES.map(sv=>({ id: `tech_${sv.id}`, title: sv.label })) }],
            },
          },
        });
        return done();
      }

      // technician - service selected
      if (id?.startsWith("tech_srv_") || id?.startsWith("tech_")) {
        // normalize id to service id
        const norm = id.replace(/^tech_srv_/, "").replace(/^tech_/, "");
        const valid = SERVICES.find(sv=>sv.id===norm);
        if (valid) {
          s.techServiceId = norm;
          await sessSet(from, s);
          await sendZonaGroupButtons(from);
          await sendText(from, "Selecciona tu zona para completar el registro.");
          return done();
        }
      }

      if (id === "zona_group_1_10") {
        s.finalAcked = false; await sessSet(from, s);
        await sendZonaList(from, 1, 10);
        return done();
      }
      if (id === "zona_group_11_20") {
        s.finalAcked = false; await sessSet(from, s);
        await sendZonaList(from, 11, 20);
        return done();
      }
      if (id === "zona_group_21_25") {
        s.finalAcked = false; await sessSet(from, s);
        await sendZonaList(from, 21, 25);
        return done();
      }

      if (id === "zona_change") {
        s.state = "MENU"; s.finalAcked = false; await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return done();
      }
      if (id === "zona_confirm") {
        if (!s.zone) { await sendZonaGroupButtons(from); return done(); }
        s.zoneConfirmed = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendServicesList(from, cityTitle, s.zone);
        return done();
      }

      // ADS confirm
      if (id === "ad_yes") {
        s.started = true; s.state = "MENU"; s.zoneConfirmed = true; s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return done();
      }
      if (id === "ad_change") {
        s.state = "MENU"; s.serviceId = null; s.urgency = null; s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return done();
      }

      // URGENCY answers - SAVE + ROUTE
      if (id === "urgency_now" || id === "urgency_later") {
        s.urgency = id === "urgency_now" ? "now" : "later";
        await sessSet(from, s);

        const lead = {
          phone: from,
          city: s.city?.title || "Ciudad de Guatemala",
          zona: s.zone || null,
          service: SERVICES.find((x)=>x.id===s.serviceId)?.label || null,
          urgency: s.urgency === "now" ? "Ahora" : "Luego",
          lang: s.lang || "es",
          campaign_id: s.campaign_id || null,
        };

        // score - simple rules
        lead.lead_score = scoreLead(lead);

        const saved = await saveLeadToSupabase(lead);
        if (!saved) log.warn("[Lead] not saved (Supabase disabled or error)");

        // route to techs
        await pickSuppliers(lead);

        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
        s.state = "DONE"; s.lastConfirmation = finalText; s.finalAcked = false;
        await sessSet(from, s);
        await coolSet(from);
        return done();
      }

      // Final ack
      if (id === "final_ack") {
        if (await coolHas(from)) {
          if (s.finalAcked) return done();
          s.finalAcked = true; await sessSet(from, s);
          await sendText(from, "Confirmar ✅");
          return done();
        } else {
          await sessDel(from);
          const fresh = {
            city: null, zone: null, zoneConfirmed: false,
            serviceId: null, urgency: null,
            started: false, state: "MENU", lastConfirmation: null,
            finalAcked: false, source: null, adLockCity: false,
            lang: "es", campaign_id: null, role: "cliente", pendingConfirm: null,
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return done();
        }
      }

      // Regex confirm
      if (id === "regex_confirm") {
        if (!s.pendingConfirm?.serviceId || !s.pendingConfirm?.zona) {
          await sendText(from, "Faltan datos - vuelve a escribir por favor: servicio y zona.");
          return done();
        }
        s.serviceId = s.pendingConfirm.serviceId;
        s.zone = s.pendingConfirm.zona;
        s.zoneConfirmed = true;
        s.urgency = s.pendingConfirm.urgency === "Ahora" ? "now" : "later";
        s.started = true;
        s.state = "MENU";
        s.finalAcked = false;
        await sessSet(from, s);

        const lead = {
          phone: from,
          city: s.city?.title || "Ciudad de Guatemala",
          zona: s.zone,
          service: SERVICES.find((x)=>x.id===s.serviceId)?.label || null,
          urgency: s.urgency === "now" ? "Ahora" : "Luego",
          lang: s.lang || "es",
          campaign_id: s.campaign_id || null,
        };
        lead.lead_score = scoreLead(lead);

        const saved = await saveLeadToSupabase(lead);
        if (!saved) log.warn("[Lead] not saved (Supabase disabled or error)");

        // route
        await pickSuppliers(lead);

        const finalText = await sendLeadReady(from, lead.city, lead.zona, s.serviceId);
        s.state = "DONE"; s.lastConfirmation = finalText; s.finalAcked = false; s.pendingConfirm = null;
        await sessSet(from, s);
        await coolSet(from);
        return done();
      }
      if (id === "regex_change") {
        s.pendingConfirm = null; await sessSet(from, s);
        await sendRoleButtons(from);
        return done();
      }
    }

    // list reply - technician zone selection
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;
      if (id?.startsWith("zona_") && s.role === "tecnico" && s.techServiceId) {
        const z = parseInt(id.split("_")[1], 10);
        if (z>=1 && z<=25) {
          // register technician
          try {
            await supabase.from("technicians").insert([
              { phone: from, service_id: s.techServiceId, zona: z, active: true }
            ]);
            await sendText(from, "Registro completado ✅. Empezarás a recibir clientes de tu zona.");
          } catch (e) {
            log.warn({ err: e?.message || e }, "[Technician] insert failed");
            await sendText(from, "Hubo un problema al registrar. Intenta más tarde.");
          }
          s.techServiceId = null; await sessSet(from, s);
          return done();
        }
      }
    }

    // fallback if city missing (respect ad lock)
    if (!s.city) {
      if (s.adLockCity && s.city) {
        await sendZonaGroupButtons(from);
      } else {
        await sendCityMenu(from);
      }
      return done();
    }

    return done();
  } catch (err) {
    log.error({ err: err?.response?.data || err?.message || err }, "Webhook POST error");
    return res.sendStatus(200);
  }
});

// ===== recoverUI =====
async function recoverUI(to, s){
  if (!s.started) return sendStartConfirm(to);
  if (!s.city) return sendCityMenu(to);
  if (!s.zone) return sendZonaGroupButtons(to);
  if (!s.zoneConfirmed) return sendZonaConfirm(to, s.zone);
  if (!s.serviceId) {
    const cityTitle = s.city?.title || "Ciudad de Guatemala";
    return sendServicesList(to, cityTitle, s.zone);
  }
  if (!s.urgency) return sendUrgencyQuestion(to);
  const cityTitle = s.city?.title || "Ciudad de Guatemala";
  const finalText = await sendLeadReady(to, cityTitle, s.zone, s.serviceId);
  s.state = "DONE"; s.lastConfirmation = finalText; s.finalAcked = false;
  await sessSet(to, s);
}

// ===== simple rule-based lead score =====
function scoreLead(lead){
  let score = 0;
  if (lead.urgency === "Ahora") score += 40;
  const sid = SERVICE_NAME_TO_ID[(lead.service||"").toLowerCase()] || null;
  if (sid && ["srv_plomero","srv_electricista","srv_cerrajero"].includes(sid)) score += 30;
  const z = Number(lead.zona||0);
  if ([10,14,15].includes(z)) score += 20;
  return Math.min(100, score);
}

// ===== Start server =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>log.info({ port: PORT }, "Server running [V3.3.2 Stable]"));