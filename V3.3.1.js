require('dotenv').config();
console.log("ENV LOADED:", process.env.WHATSAPP_TOKEN ? "OK" : "MISSING");
// index.js — Servicio24 V3.3.1 Stable
// WhatsApp Flow for Leads (City -> Zone -> Service -> Urgency -> Final)
// Features: Ads prefill + confirm, Redis sessions (fallback memory),
// cooldown, "Gracias"/final-ack single-use, Supabase leads, full webhook logs,
// language + campaign_id flags, safer error handling, clean logs.

// ===== Imports =====
const express = require("express");
const axios = require("axios");
const pino = require("pino");

// ===== Supabase (server-side only) =====
let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  const SUPABASE_URL = process.env.SUPABASE_URL || "";
  const SUPABASE_SERVICE_KEY =
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "";
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log("[Supabase] client initialized");
  } else {
    console.warn("[Supabase] missing SUPABASE_URL or SUPABASE_SERVICE_KEY — leads will NOT be saved");
  }
} catch (e) {
  console.warn("[Supabase] package not installed — run: npm i @supabase/supabase-js");
}

// ===== Logger =====
const log = pino({ level: process.env.LOG_LEVEL || "info" });

// ===== App =====
const app = express();
app.use(express.json());

// ===== Config =====
const GRAPH_VERSION = process.env.GRAPH_VERSION || "23.0";
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || "6", 10);
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || "45", 10);
const RESET_MAGIC = (process.env.RESET_MAGIC || "oga").toLowerCase();

const GRAPH_BASE = `https://graph.facebook.com/v${GRAPH_VERSION}`;
const GRAPH_URL = `${GRAPH_BASE}/${process.env.PHONE_NUMBER_ID}/messages`;
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

// ===== Redis (fallback to memory) =====
let redis = null;
let useMemory = false;
try {
  const Redis = require("ioredis");
  if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
    });
    redis.on("connect", () => log.info("[Redis] connected"));
    redis.on("error", (e) => {
      log.error({ err: e?.message || e }, "[Redis] error");
      redis = null;
      useMemory = true;
    });
  } else {
    useMemory = true;
    log.warn("[Redis] REDIS_URL missing — using in-memory sessions");
  }
} catch {
  useMemory = true;
  log.warn("[Redis] ioredis not available — using in-memory sessions");
}

const mem = new Map();     // sessions
const memCool = new Set(); // cooldown keys

// --- session helpers
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

// --- cooldown helpers
async function coolSet(userId, minutes = COOLDOWN_MINUTES) {
  const k = `s24:cool:${userId}`;
  if (!useMemory && redis) {
    await redis.set(k, "1", "EX", minutes * 60);
  } else {
    memCool.add(k);
    setTimeout(() => memCool.delete(k), minutes * 60 * 1000).unref?.();
  }
}
async function coolHas(userId) {
  const k = `s24:cool:${userId}`;
  if (!useMemory && redis) return (await redis.exists(k)) === 1;
  return memCool.has(k);
}
async function coolDel(userId) {
  const k = `s24:cool:${userId}`;
  if (!useMemory && redis) await redis.del(k);
  memCool.delete(k);
}

// ===== Static Data =====
const CITIES = [{ id: "city_guatemala", title: "Ciudad de Guatemala" }];

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
  1: "🏛️",  2: "🍺",  3: "🕊️",  4: "💰",  5: "🏟️",
  6: "🏘️",  7: "🏺",  8: "🚌",  9: "🏨", 10: "🎉",
 11: "🛒", 12: "🧰", 13: "✈️", 14: "🏢", 15: "🎓",
 16: "🏰", 17: "🏭", 18: "🛣️", 19: "🔧", 20: "🏚️",
 21: "🚧", 22: "📦", 23: "🚋", 24: "🏗️", 25: "🌳",
};

// ===== WhatsApp helpers =====
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
function sendInteractiveButton(to, headerText, bodyText, buttonId, buttonTitle) {
  return postWA({
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
function sendStartConfirm(to) {
  return postWA({
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
function sendRoleButtons(to) {
  return postWA({
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
function sendCityMenu(to) {
  return postWA({
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
          { title: "Ciudades", rows: CITIES.map((c) => ({ id: c.id, title: c.title })) },
        ],
      },
    },
  });
}
function sendZonaGroupButtons(to) {
  return postWA({
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
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  return postWA({
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
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return postWA({
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
      body: {
        text:
          `Selecciona el profesional que necesitas:\n\n` +
          `${cityTitle}\n\n` +
          `Zona ${z} ${zEmoji}\n\n` +
          `${consent}`,
      },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [
          { title: "Profesionales", rows: SERVICES.map((s) => ({ id: s.id, title: `${s.label} ${s.emoji}` })) },
        ],
      },
    },
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
function sendFinalInteractive(to, finalText) {
  return sendInteractiveButton(to, "Servicio24", finalText, "final_ack", "Confirmar ✅");
}
async function sendLeadReady(to, cityTitle, zone, serviceId) {
  const svc = SERVICES.find((s) => s.id === serviceId);
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

// ===== Ads prefill parsing =====
function parseAdParams(rawText) {
  if (!rawText) return null;
  const text = String(rawText).trim();
  const m = text.match(/#ad\s+(.+)$/i);
  if (!m) return null;
  const qs = m[1];

  const params = {};
  qs.split("&").forEach((kv) => {
    const [k, v] = kv.split("=").map((x) => (x || "").trim());
    if (!k) return;
    params[k.toLowerCase()] = decodeURIComponent((v || "").trim());
  });

  let cityId = params.city || params.ciudad || params.c;
  let zoneStr = params.zone || params.zona || params.z;
  let service = params.service || params.servicio || params.s;
  let lang = params.lang || "es";
  let campaign_id = params.cid || params.campaign || null;

  // normalize service
  let serviceId = null;
  if (service) {
    const sv = service.toLowerCase();
    serviceId = SERVICE_LABEL[sv] ? sv : SERVICE_NAME_TO_ID[sv] || null;
    if (!serviceId && sv.startsWith("srv_")) serviceId = sv;
  }

  const zone = zoneStr ? parseInt(zoneStr, 10) : null;

  // normalize city
  let city = null;
  if (cityId) {
    const found = CITIES.find((c) => c.id === cityId);
    if (found) city = found;
  }
  if (!city) city = CITIES[0];

  return {
    city,
    zone: zone && zone >= 1 && zone <= 25 ? zone : null,
    serviceId: serviceId && SERVICE_LABEL[serviceId] ? serviceId : null,
    lang: ["es", "en"].includes((lang || "").toLowerCase()) ? lang.toLowerCase() : "es",
    campaign_id: campaign_id || null,
  };
}

// ===== Verify (GET) =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// ===== Save lead =====
async function saveLeadToSupabase({ phone, city, zona, service, urgency, lang, campaign_id }) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("leads").insert([
      { phone, city, zona, service, urgency, lang, campaign_id },
    ]);
    if (error) {
      log.error({ err: error.message }, "[Supabase] insert error");
      return false;
    }
    log.info({ phone, zona, service }, "[Lead] saved");
    return true;
  } catch (e) {
    log.error({ err: e?.message || e }, "[Supabase] unexpected error");
    return false;
  }
}

// ===== Receive (POST) — clean logs =====
app.post("/webhook", async (req, res) => {
  // payload מלא יוצג רק כש־LOG_LEVEL=debug
  log.debug({ webhook: req.body }, "webhook_raw");

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    // No message → still 200 (delivery/status events, etc.)
    if (!msg) return res.sendStatus(200);

    console.log("Webhook from:", msg?.from);

    const from = msg.from;

    // ensure session
    let s = await sessGet(from);
    if (!s) {
      s = {
        city: null,
        zone: null,
        zoneConfirmed: false,
        serviceId: null,
        urgency: null, // "now"/"later"
        started: false,
        state: "MENU",
        lastConfirmation: null,
        finalAcked: false,
        source: null, // "ad" | null
        adLockCity: false,
        lang: "es",
        campaign_id: null,
      };
      await sessSet(from, s);
    }

    // ===== MAGIC RESET any time =====
    if (msg.type === "text") {
      const bodyRaw = msg.text?.body || "";
      const body = bodyRaw.trim().toLowerCase();

      if (body === RESET_MAGIC) {
        await coolDel(from);
        await sessDel(from);
        const fresh = {
          city: null,
          zone: null,
          zoneConfirmed: false,
          serviceId: null,
          urgency: null,
          started: false,
          state: "MENU",
          lastConfirmation: null,
          finalAcked: false,
          source: null,
          adLockCity: false,
          lang: "es",
          campaign_id: null,
        };
        await sessSet(from, fresh);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }

      // First text → try detect Ad params
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
          s.lang = ad.lang || "es";
          s.campaign_id = ad.campaign_id || null;
          await sessSet(from, s);
          await sendAdConfirm(from, s.city.title, s.zone, s.serviceId);
          return res.sendStatus(200);
        }
      }

      // If DONE — echo final card once (single-use)
      if (s.state === "DONE") {
        if (await coolHas(from)) {
          if (s.finalAcked) return res.sendStatus(200);
          const fallback =
            s.lastConfirmation ||
            `Listo ✅\n\n${(SERVICES.find((x) => x.id === s.serviceId)?.label || "Profesional")} ${
              SERVICES.find((x) => x.id === s.serviceId)?.emoji || "👤"
            }\n\n${s.city?.title || "Ciudad de Guatemala"}\n\nZona ${s.zone} ${
              ZONA_EMOJI[s.zone] || ""
            }\n\nEn breve te contactarán profesionales cercanos.`;
          await sendFinalInteractive(from, fallback);
          s.finalAcked = true;
          await sessSet(from, s);
          return res.sendStatus(200);
        } else {
          // cooldown expired → fresh flow
          await sessDel(from);
          const fresh = {
            city: null,
            zone: null,
            zoneConfirmed: false,
            serviceId: null,
            urgency: null,
            started: false,
            state: "MENU",
            lastConfirmation: null,
            finalAcked: false,
            source: null,
            adLockCity: false,
            lang: "es",
            campaign_id: null,
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return res.sendStatus(200);
        }
      }

      // Regular text → recover UI (הפונקציה נוספה למטה)
      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    // list reply
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // city (only if not ad-locked)
      if (CITIES.some((c) => c.id === id)) {
        if (s.adLockCity) {
          await sendZonaGroupButtons(from);
          return res.sendStatus(200);
        }
        const city = CITIES.find((c) => c.id === id);
        s.city = city;
        s.zone = null;
        s.zoneConfirmed = false;
        s.serviceId = null;
        s.urgency = null;
        s.started = true;
        s.state = "MENU";
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // exact zona
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z >= 1 && z <= 25) {
          s.zone = z;
          s.zoneConfirmed = false;
          s.serviceId = null;
          s.urgency = null;
          s.state = "MENU";
          s.finalAcked = false;
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
        s.urgency = null;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }
    }

    // button reply
    if (interactive?.type === "button_reply") {
      const id = interactive.button_reply?.id;

      if (id === "start_yes") {
        s.started = true;
        s.state = "MENU";
        s.finalAcked = false;
        await sessSet(from, s);
        await sendRoleButtons(from);
        return res.sendStatus(200);
      }
      if (id === "start_no") {
        await sendText(from, "Operación cancelada.\n\nServicio24");
        return res.sendStatus(200);
      }

      if (id === "role_cliente") {
        s.finalAcked = false;
        await sessSet(from, s);
        s.adLockCity ? await sendZonaGroupButtons(from) : await sendCityMenu(from);
        return res.sendStatus(200);
      }
      if (id === "role_tecnico") {
        await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24");
        return res.sendStatus(200);
      }

      if (id === "zona_group_1_10") {
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaList(from, 1, 10);
        return res.sendStatus(200);
      }
      if (id === "zona_group_11_20") {
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaList(from, 11, 20);
        return res.sendStatus(200);
      }
      if (id === "zona_group_21_25") {
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaList(from, 21, 25);
        return res.sendStatus(200);
      }

      if (id === "zona_change") {
        s.state = "MENU";
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }
      if (id === "zona_confirm") {
        if (!s.zone) {
          await sendZonaGroupButtons(from);
          return res.sendStatus(200);
        }
        s.zoneConfirmed = true;
        s.state = "MENU";
        s.finalAcked = false;
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendServicesList(from, cityTitle, s.zone);
        return res.sendStatus(200);
      }

      // ADS confirm
      if (id === "ad_yes") {
        s.started = true;
        s.state = "MENU";
        s.zoneConfirmed = true;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }
      if (id === "ad_change") {
        s.state = "MENU";
        s.serviceId = null;
        s.urgency = null;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // URGENCY answers → SAVE LEAD, then final card
      if (id === "urgency_now" || id === "urgency_later") {
        s.urgency = id === "urgency_now" ? "now" : "later";
        await sessSet(from, s);

        const lead = {
          phone: from,
          city: s.city?.title || "Ciudad de Guatemala",
          zona: s.zone || null,
          service: SERVICES.find((x) => x.id === s.serviceId)?.label || null,
          urgency: s.urgency === "now" ? "Ahora" : "Luego",
          lang: s.lang || "es",
          campaign_id: s.campaign_id || null,
        };
        const saved = await saveLeadToSupabase(lead);
        if (!saved) log.warn("[Lead] not saved (Supabase disabled or error)");

        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
        s.state = "DONE";
        s.lastConfirmation = finalText;
        s.finalAcked = false;
        await sessSet(from, s);
        await coolSet(from);
        return res.sendStatus(200);
      }

      // Final ack single-use
      if (id === "final_ack") {
        if (await coolHas(from)) {
          if (s.finalAcked) return res.sendStatus(200);
          s.finalAcked = true;
          await sessSet(from, s);
          await sendText(from, "Confirmar ✅");
          return res.sendStatus(200);
        } else {
          await sessDel(from);
          const fresh = {
            city: null,
            zone: null,
            zoneConfirmed: false,
            serviceId: null,
            urgency: null,
            started: false,
            state: "MENU",
            lastConfirmation: null,
            finalAcked: false,
            source: null,
            adLockCity: false,
            lang: "es",
            campaign_id: null,
          };
          await sessSet(from, fresh);
          await sendStartConfirm(from);
          return res.sendStatus(200);
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
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    log.error({ err: err?.response?.data || err?.message || err }, "Webhook POST error");
    return res.sendStatus(200);
  }
});

// ===== Ads confirm screen =====
function sendAdConfirm(to, cityTitle, zone, serviceId) {
  const svc = SERVICES.find((s) => s.id === serviceId);
  const svcText = svc ? `${svc.label} ${svc.emoji}` : "Profesional 👤";
  const zEmoji = ZONA_EMOJI[zone] || "";
  const body = `¿Buscas *${svcText}* en *${cityTitle}*?\nZona ${zone} ${zEmoji}`;
  return postWA({
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

// ===== UI Recovery (added) =====
async function recoverUI(to, s) {
  if (!s.started) { await sendStartConfirm(to); return; }
  if (!s.city)    { await sendCityMenu(to);    return; }
  if (!s.zone)    { await sendZonaGroupButtons(to); return; }
  if (!s.zoneConfirmed) { await sendZonaConfirm(to, s.zone); return; }
  if (!s.serviceId) {
    const cityTitle = s.city?.title || "Ciudad de Guatemala";
    await sendServicesList(to, cityTitle, s.zone);
    return;
  }
  if (!s.urgency) { await sendUrgencyQuestion(to); return; }
  if (s.state === "DONE") {
    if (await coolHas(to)) {
      if (!s.finalAcked) {
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(to, cityTitle, s.zone, s.serviceId);
        s.lastConfirmation = finalText;
        s.finalAcked = false;
        await sessSet(to, s);
      }
    } else {
      await sessDel(to);
      const fresh = {
        city: null, zone: null, zoneConfirmed: false, serviceId: null, urgency: null,
        started: false, state: "MENU", lastConfirmation: null, finalAcked: false,
        source: null, adLockCity: false, lang: "es", campaign_id: null,
      };
      await sessSet(to, fresh);
      await sendStartConfirm(to);
    }
    return;
  }
  await sendStartConfirm(to);
}

// ===== Health =====
app.get("/", (_req, res) =>
  res.status(200).send("🚀 Servicio24 — V3.3.1 Stable (clean logs + Ads + Redis + Cooldown + Supabase + UI recover)")
);

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log.info({ port: PORT }, "Server running [V3.3.1 Stable]"));
