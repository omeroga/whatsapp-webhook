// index.js — Servicio24 V3 Barzel Stable (Ads + Gracias + Urgency + Formatting)
// - Graph API v${GRAPH_VERSION}
// - Redis sessions (fallback to memory)
// - Full emojis for ZONAS & services
// - Free-text flow + cooldown + magic reset
// - Final confirmation is INTERACTIVE with single-use "Gracias" (no new lead)
// - Urgency question after service selection (internal flag only, not shown to client in final text)
// - Ads flow: prefill city/zone/service, confirm "Sí ✅ / Cambiar 🔄", city locked for ads
// - Multi-line final message (with blank lines), unified across organic/ads
// - City shown before Zone everywhere
// - No "Servicio24" inside body texts (only header/footer)

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

const mem = new Map();     // session store
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
const SERVICE_NAME_TO_ID = (() => {
  const map = {};
  for (const s of SERVICES) map[s.label.toLowerCase()] = s.id;
  // aliases comunes
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

// ===== WhatsApp helpers =====
function postWA(payload) { return axios.post(GRAPH_URL, payload, AUTH); }
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

// ===== services list + consent (City line, blank line, Zone line, blank line, consent) =====
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas que tus datos se compartan con profesionales cercanos y que puedas recibir sus llamadas o mensajes. Sin costo._";

  const bodyText =
    `Selecciona el profesional que necesitas:\n\n` +
    `${cityTitle}\n\n` +
    `Zona ${z} ${zEmoji}\n\n` +
    `${consent}`;

  return postWA({
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body:   { text: bodyText },
      footer: { text: "Servicio24" },
      action: {
        button: "Seleccionar servicio",
        sections: [{ title: "Profesionales", rows: SERVICES.map(s => ({ id: s.id, title: `${s.label} ${s.emoji}` })) }]
      }
    }
  });
}

// ===== URGENCY question (after service selection) =====
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

// ===== FINAL interactive ("Gracias") — keeps keyboard closed =====
function sendFinalInteractive(to, finalText) {
  return sendInteractiveButton(
    to,
    "Servicio24",
    finalText,
    "final_ack",
    "Gracias 🙏"
  );
}

// ===== FINAL lead (INTERACTIVE) — unified multiline (City then Zone) =====
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

// ===== ADS: parsing prefill from first text =====
// Pattern example:  "#ad city=city_guatemala&zone=7&service=srv_electricista"
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

  // normalize service
  let serviceId = null;
  if (service) {
    const sv = service.toLowerCase();
    serviceId = SERVICE_LABEL[sv] ? sv : (SERVICE_NAME_TO_ID[sv] || null);
    if (!serviceId && sv.startsWith("srv_")) serviceId = sv;
  }

  const zone = zoneStr ? parseInt(zoneStr, 10) : null;

  // normalize city
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

// ===== ADS confirm screen (with service emoji; City then Zone) =====
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

// ===== Free-text behavior =====
async function recoverUI(from, s) {
  if (!s.started) { await sendStartConfirm(from); return; }

  // ADS flow: respect ad city lock
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

  // Organic flow
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
      s = {
        city:null, zone:null, zoneConfirmed:false, serviceId:null,
        urgency:null, // "now" | "later"
        started:false, state:"MENU", lastConfirmation:null, finalAcked:false,
        source:null,    // "ad" | null
        adLockCity:false
      };
      await sessSet(from, s);
    }

    // MAGIC RESET — anytime
    if (msg.type === "text") {
      const bodyRaw = (msg.text?.body || "");
      const body = bodyRaw.trim().toLowerCase();

      if (body === RESET_MAGIC) {
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

      // First text → try detect Ad params
      if (!s.started) {
        const ad = parseAdParams(bodyRaw);
        if (ad && ad.city && ad.zone && ad.serviceId) {
          // Prefill from ads
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

      // If DONE
      if (s.state === "DONE") {
        if (await coolHas(from)) {
          if (s.finalAcked) return res.sendStatus(200);
          const fallback =
            s.lastConfirmation ||
            (
              `Listo ✅\n\n` +
              `${(SERVICES.find(x => x.id === s.serviceId)?.label || "Profesional")} ` +
              `${(SERVICES.find(x => x.id === s.serviceId)?.emoji || "👤")}\n\n` +
              `${(s.city?.title || "Ciudad de Guatemala")}\n\n` +
              `Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")}\n\n` +
              `En breve te contactarán profesionales cercanos.`
            );
          await sendFinalInteractive(from, fallback);
          s.finalAcked = true;
          await sessSet(from, s);
          return res.sendStatus(200);
        } else {
          // cooldown expired → start fresh
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

      // Regular text → show current UI
      await recoverUI(from, s);
      return res.sendStatus(200);
    }

    const interactive = msg.interactive;

    // list reply
    if (interactive?.type === "list_reply") {
      const id = interactive.list_reply?.id;

      // city (only if not ad-locked)
      if (CITIES.some(c => c.id === id)) {
        if (s.adLockCity) {
          // ignore city change in ad flow; go pick zone
          await sendZonaGroupButtons(from);
          return res.sendStatus(200);
        }
        const city = CITIES.find(c => c.id === id);
        s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
        s.started = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // exact zona
      if (id?.startsWith("zona_")) {
        const z = parseInt(id.split("_")[1], 10);
        if (z >= 1 && z <= 25) {
          s.zone = z; s.zoneConfirmed = false; s.serviceId = null; s.urgency = null;
          s.state = "MENU"; s.finalAcked = false;
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
        s.urgency = null; // reset for new service choice
        s.finalAcked = false;
        await sessSet(from, s);
        // ask urgency (last question)
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }
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

      if (id === "zona_change") { s.state = "MENU"; s.finalAcked = false; await sessSet(from, s); await sendZonaGroupButtons(from); return res.sendStatus(200); }
      if (id === "zona_confirm") {
        if (!s.zone) { await sendZonaGroupButtons(from); return res.sendStatus(200); }
        s.zoneConfirmed = true; s.state = "MENU"; s.finalAcked = false;
        await sessSet(from, s);
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        await sendServicesList(from, cityTitle, s.zone);
        return res.sendStatus(200);
      }

      // ADS confirm buttons
      if (id === "ad_yes") {
        // accept the prefilled city/zone/service — go to urgency
        s.started = true;
        s.state = "MENU";
        s.zoneConfirmed = true;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendUrgencyQuestion(from);
        return res.sendStatus(200);
      }
      if (id === "ad_change") {
        // City locked; ask zone first, then service
        s.state = "MENU";
        s.serviceId = null;
        s.urgency = null;
        s.finalAcked = false;
        await sessSet(from, s);
        await sendZonaGroupButtons(from);
        return res.sendStatus(200);
      }

      // URGENCY answers
      if (id === "urgency_now" || id === "urgency_later") {
        s.urgency = (id === "urgency_now") ? "now" : "later"; // internal only
        await sessSet(from, s);
        // proceed to final lead creation
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
        s.state = "DONE";
        s.lastConfirmation = finalText;
        s.finalAcked = false;     // allow one final interactive echo
        await sessSet(from, s);
        await coolSet(from);      // start cooldown
        return res.sendStatus(200);
      }

      // final ack button — allow ONCE per cooldown window
      if (id === "final_ack") {
        if (await coolHas(from)) {
          if (s.finalAcked) {
            return res.sendStatus(200); // ignore further presses during cooldown
          }
          const finalText =
            s.lastConfirmation ||
            (
              `Listo ✅\n\n` +
              `${(SERVICES.find(x => x.id === s.serviceId)?.label || "Profesional")} ` +
              `${(SERVICES.find(x => x.id === s.serviceId)?.emoji || "👤")}\n\n` +
              `${(s.city?.title || "Ciudad de Guatemala")}\n\n` +
              `Zona ${s.zone} ${(ZONA_EMOJI[s.zone] || "")}\n\n` +
              `En breve te contactarán profesionales cercanos.`
            );
          await sendFinalInteractive(from, finalText);
          s.finalAcked = true;
          await sessSet(from, s);
          return res.sendStatus(200);
        } else {
          // cooldown expired → this press acts like fresh start prompt
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
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ===== Health =====
app.get("/", (_req, res) =>
  res.status(200).send("🚀 Servicio24 — V3 Barzel Stable (Ads + Redis + Emojis + Cooldown + Reset + Urgency + Gracias single-use + Formatting)"),
);

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V3 Barzel Stable]`));
```0
