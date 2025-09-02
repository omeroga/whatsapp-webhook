// index.js - Servicio24 V2 Barzel Stable + Limits + Magic
// Graph API v${GRAPH_VERSION} corrected
// Redis sessions with in-memory fallback
// Full emojis for ZONAS and services
// Free-text logic: same menu before DONE, final confirmation after DONE
// Consent text updated
// Anti-spam: cooldown 60m, dedup 6h for same request, daily limit 3
// Admin magic word: rahmani - clears limits and resets to start for testing
// No dotenv (Render reads ENV)

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

// ===== Anti-spam params =====
const COOLDOWN_MINUTES = parseInt(process.env.LEAD_COOLDOWN_MIN || "60", 10);   // גלובלי בין לידים
const DEDUP_HOURS      = parseInt(process.env.LEAD_DEDUP_HOURS || "6", 10);     // לאותו שירות+zona+עיר
const DAILY_LIMIT      = parseInt(process.env.LEAD_DAILY_LIMIT || "3", 10);     // לידים ב-24h פר משתמש

// ===== Admin Magic Word =====
const ADMIN_MAGIC_WORD = "rahmani"; // lowercase match

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
async function sessSet(userId, s, ttlSec = 60 * 60 * 24) { // 24h session TTL
  s.ts = Date.now();
  if (!useMemory && redis) {
    await redis.set(`s24:sess:${userId}`, JSON.stringify(s), "EX", ttlSec);
  } else {
    mem.set(userId, s);
    setTimeout(() => mem.delete(userId), ttlSec * 1000).unref?.();
  }
}

// ===== Anti-spam storage (fallback memory) =====
const memCooldown = new Map(); // key: user -> expireAt
const memDaily    = new Map(); // key: user -> {count, expireAt}
const memDedup    = new Map(); // key: user:city:zone:service -> expireAt

async function clearAntiSpam(user) {
  const cdKey  = `s24:cd:${user}`;
  const dayKey = `s24:day:${user}`;
  if (!useMemory && redis) {
    // delete cooldown and daily
    await redis.del(cdKey);
    await redis.del(dayKey);
    // delete all dedup keys for this user
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `s24:d:${user}:*`, "COUNT", 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } else {
    memCooldown.delete(user);
    memDaily.delete(user);
    for (const k of Array.from(memDedup.keys())) {
      if (k.startsWith(`s24:d:${user}:`)) memDedup.delete(k);
    }
  }
}

async function canCreateLead(user, cityId, zone, serviceId, s) {
  // Bypass for next lead if admin magic was used
  if (s?.adminBypass) return { ok: true, bypass: true };

  const cdKey   = `s24:cd:${user}`;
  const dayKey  = `s24:day:${user}`;
  const dKey    = `s24:d:${user}:${cityId || "city"}:${zone || "z"}:${serviceId || "srv"}`;

  // Cooldown check
  if (!useMemory && redis) {
    const hasCd = await redis.exists(cdKey);
    if (hasCd) return { ok: false, reason: "cooldown" };
  } else {
    const exp = memCooldown.get(user);
    if (exp && exp > Date.now()) return { ok: false, reason: "cooldown" };
  }

  // Daily limit check
  if (!useMemory && redis) {
    const cnt = parseInt(await redis.get(dayKey) || "0", 10);
    if (cnt >= DAILY_LIMIT) return { ok: false, reason: "daily" };
  } else {
    const d = memDaily.get(user);
    if (d && d.count >= DAILY_LIMIT && d.expireAt > Date.now()) return { ok: false, reason: "daily" };
  }

  // Dedup same request check
  if (!useMemory && redis) {
    const hasDup = await redis.exists(dKey);
    if (hasDup) return { ok: false, reason: "dedup" };
  } else {
    const exp = memDedup.get(dKey);
    if (exp && exp > Date.now()) return { ok: false, reason: "dedup" };
  }

  return { ok: true };
}

async function recordLead(user, cityId, zone, serviceId) {
  const cdKey   = `s24:cd:${user}`;
  const dayKey  = `s24:day:${user}`;
  const dKey    = `s24:d:${user}:${cityId || "city"}:${zone || "z"}:${serviceId || "srv"}`;

  if (!useMemory && redis) {
    // cooldown
    await redis.set(cdKey, "1", "EX", COOLDOWN_MINUTES * 60);

    // daily counter with rolling 24h window
    const newCnt = await redis.incr(dayKey);
    if (newCnt === 1) await redis.expire(dayKey, 24 * 60 * 60);

    // dedup per tuple
    await redis.set(dKey, "1", "EX", DEDUP_HOURS * 60 * 60);
  } else {
    // cooldown
    memCooldown.set(user, Date.now() + COOLDOWN_MINUTES * 60 * 1000);
    setTimeout(() => memCooldown.delete(user), COOLDOWN_MINUTES * 60 * 1000).unref?.();

    // daily
    const cur = memDaily.get(user);
    if (!cur || cur.expireAt <= Date.now()) {
      const expireAt = Date.now() + 24 * 60 * 60 * 1000;
      memDaily.set(user, { count: 1, expireAt });
      setTimeout(() => memDaily.delete(user), expireAt - Date.now()).unref?.();
    } else {
      cur.count += 1;
      memDaily.set(user, cur);
    }

    // dedup
    const expAt = Date.now() + DEDUP_HOURS * 60 * 60 * 1000;
    const dKeyMem = `s24:d:${user}:${cityId || "city"}:${zone || "z"}:${serviceId || "srv"}`;
    memDedup.set(dKeyMem, expAt);
    setTimeout(() => memDedup.delete(dKeyMem), DEDUP_HOURS * 60 * 60 * 1000).unref?.();
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
  return text; // לשימוש במסך DONE
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
      s = { city: null, zone: null, zoneConfirmed: false, serviceId: null, started: false, state: "MENU", lastConfirmation: null, ts: Date.now() };
      await sessSet(from, s);
    }

    // TEXT - according to state
    if (msg.type === "text") {
      const rawBody = (msg.text?.body || "");
      const body = rawBody.trim().toLowerCase();

      // Admin magic word - clear limits and reset to start with bypass
      if (ADMIN_MAGIC_WORD && body === ADMIN_MAGIC_WORD) {
        await clearAntiSpam(from);
        s = {
          city: null, zone: null, zoneConfirmed: false, serviceId: null,
          started: false, state: "MENU", lastConfirmation: null, ts: Date.now(), adminBypass: true
        };
        await sessSet(from, s);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }

      // User reset words
      const RESET = new Set(["menu","nuevo","reiniciar","reset","inicio","start"]);
      if (RESET.has(body)) {
        s = { city: null, zone: null, zoneConfirmed: false, serviceId: null, started: false, state: "MENU", lastConfirmation: null, ts: Date.now() };
        await sessSet(from, s);
        await sendStartConfirm(from);
        return res.sendStatus(200);
      }

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

        // Anti-spam checks before creating a lead
        const cityId = s.city?.id || "city_guatemala";
        const chk = await canCreateLead(from, cityId, s.zone, id, s);
        if (!chk.ok) {
          if (chk.reason === "cooldown") {
            await sendText(from, "Tu solicitud reciente está en proceso. Podrás crear otra en aproximadamente 1 hora.");
          } else if (chk.reason === "dedup") {
            await sendText(from, "Ya recibimos una solicitud igual recientemente. Inténtalo más tarde.");
          } else if (chk.reason === "daily") {
            await sendText(from, "Has alcanzado el límite de solicitudes por hoy. Intenta de nuevo mañana.");
          } else {
            await sendText(from, "No es posible crear otra solicitud por el momento.");
          }
          return res.sendStatus(200);
        }

        // Create lead
        s.serviceId = id;
        const cityTitle = s.city?.title || "Ciudad de Guatemala";
        const finalText = await sendLeadReady(from, cityTitle, s.zone, s.serviceId);

        // Record anti-spam limits unless bypass was used
        if (!s.adminBypass) {
          await recordLead(from, cityId, s.zone, s.serviceId);
        }

        // Final state
        s.state = "DONE";
        s.lastConfirmation = finalText;
        if (s.adminBypass) delete s.adminBypass; // one-time bypass
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
app.get("/", (_req, res) => res.status(200).send("🚀 Servicio24 — V2 Barzel Stable (Redis + Full Emojis + Limits + Magic)"));

// ===== Start =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V2 Barzel Stable + Limits + Magic]`));
