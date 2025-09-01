// index.js
// === Servicio24: V2 ברזל — יציב לעומסים (Redis + Idempotency + Retries) ===
// UX נשאר זהה ל-V2 ברזל: Start -> Role -> City -> ZonaGroup -> ZonaExacta -> Confirmar -> Servicios -> Lead
// שיפורי יציבות פנימיים בלבד: ניהול סשן ב-Redis, מניעת כפילויות מה-Webhook, נעילת Confirmar, retries ל-WhatsApp, תור לידים.

/* Servicios (LOCKED, שם ולאחריו אימוג'י):
Plomero 🚰 | Electricista ⚡ | Cerrajero 🔑 | Aire acondicionado ❄️ | Mecánico 🛠️ | Servicio de grúa 🛻 | Mudanza 🚚
Zonas 1-25 (LOCKED):
1 🏛️ | 2 🍺 | 3 🕊️ | 4 💰 | 5 🏟️ | 6 🏘️ | 7 🏺 | 8 🚌 | 9 🏨 | 10 🎉 |
11 🛒 | 12 🧰 | 13 ✈️ | 14 🏢 | 15 🎓 | 16 🏰 | 17 🏭 | 18 🛣️ | 19 🔧 | 20 🏚️ |
21 🚧 | 22 📦 | 23 🚋 | 24 🏗️ | 25 🌳
*/

const express = require("express");
const axios = require("axios");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

// ---------------- Env & Infra ----------------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const REDIS_URL = process.env.REDIS_URL || ""; // eg: redis://localhost:6379
const USE_REDIS = !!REDIS_URL;

const redis = USE_REDIS ? new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 }) : null;

// Axios instance עם timeout
const http = axios.create({
  timeout: 10000,
  headers: {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
});

// שליחה ל-Graph עם נסיונות חוזרים
async function postGraph(payload, tries = 3) {
  let attempt = 0, lastErr;
  const backoff = [300, 800, 1500];
  while (attempt < tries) {
    try {
      return await http.post(GRAPH_URL, payload);
    } catch (e) {
      lastErr = e;
      const wait = backoff[attempt] || 1500;
      await new Promise(r => setTimeout(r, wait));
      attempt++;
    }
  }
  console.error("Graph POST failed:", lastErr?.response?.data || lastErr?.message);
  throw lastErr;
}

// ---------------- State & Idempotency ----------------
const SESSION_TTL_SECONDS = 30 * 60;
const memSessions = new Map();
const processedMsgMem = new Set();
const lastConfirmMem = new Map();

// Session helpers
async function getSession(userId) {
  if (USE_REDIS) {
    const raw = await redis.get(`s24:session:${userId}`);
    if (raw) return JSON.parse(raw);
  } else if (memSessions.has(userId)) {
    return memSessions.get(userId);
  }
  return {
    city: null,
    zone: null,
    zoneConfirmed: false,
    serviceId: null,
    lastWelcome: 0,
    started: false,
  };
}
async function saveSession(userId, s) {
  if (USE_REDIS) {
    await redis.set(`s24:session:${userId}`, JSON.stringify(s), "EX", SESSION_TTL_SECONDS);
  } else {
    memSessions.set(userId, s);
  }
}

// Idempotency for webhook messages
async function isDuplicateMessage(messageId) {
  if (!messageId) return false; // אם אין ID נמשיך כרגיל
  if (USE_REDIS) {
    const ok = await redis.set(`s24:msg:${messageId}`, "1", "NX", "EX", 24 * 60 * 60);
    return ok === null; // קיים כבר
  } else {
    if (processedMsgMem.has(messageId)) return true;
    processedMsgMem.add(messageId);
    setTimeout(() => processedMsgMem.delete(messageId), 24 * 60 * 60 * 1000);
    return false;
  }
}

// Confirm lock - נגד לחיצות כפולות וגם נגד שידור כפול
async function acquireConfirmLock(userId, ttlSeconds = 3) {
  if (USE_REDIS) {
    const ok = await redis.set(`s24:lock:confirm:${userId}`, "1", "NX", "EX", ttlSeconds);
    return ok !== null;
  } else {
    const now = Date.now();
    const last = lastConfirmMem.get(userId) ?? 0;
    if (now - last < ttlSeconds * 1000) return false;
    lastConfirmMem.set(userId, now);
    return true;
  }
}

// Lead queue - דוחפים לתור ב-Redis לצרכן חיצוני
async function enqueueLead(lead) {
  if (USE_REDIS) {
    const key = `s24:lead:dedupe:${lead.user}:${lead.city}:${lead.zone}:${lead.service}`;
    // חלון דה-דופ 60 שניות
    const ok = await redis.set(key, "1", "NX", "EX", 60);
    if (ok !== null) {
      await redis.rpush("s24:lead_queue", JSON.stringify(lead));
    }
  } else {
    // Fallback זיכרון - לא יציב לייצור, אבל לא משנה UX
    console.log("enqueueLead(mem):", lead);
  }
}

// ---------------- Datos LOCKED ----------------
const CITIES = [{ id: "city_guatemala", title: "Ciudad de Guatemala" }];

// טבלת ברזל לבעלי מקצוע - שם ואימוג'י, האימוג'י מוצג מימין לשם
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

// ---------------- Send helpers (עם retries) ----------------
function sendText(to, text) {
  return postGraph({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  });
}
function sendStartConfirm(to) {
  return postGraph({
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
function sendRoleButtons(to) {
  return postGraph({
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
function sendCityMenu(to) {
  return postGraph({
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
        sections: [{ title: "Ciudades", rows: CITIES.map(c => ({ id: c.id, title: c.title })) }],
      },
    },
  });
}
function sendZonaGroupButtons(to) {
  return postGraph({
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
        ],
      },
    },
  });
}
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) {
    rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  }
  return postGraph({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body:   { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar zona", sections: [{ title: "Zonas", rows }] },
    },
  });
}
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return postGraph({
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
        ],
      },
    },
  });
}
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas recibir llamadas y mensajes de profesionales. Sin costo._";
  return postGraph({
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
            rows: SERVICES.map(s => ({ id: s.id, title: `${s.label} ${s.emoji}` })),
          },
        ],
      },
    },
  });
}
async function sendLeadReady(to, cityTitle, zone, serviceId, user) {
  const s = SERVICES.find(x => x.id === serviceId);
  const serviceText = s ? `${s.label} ${s.emoji}` : "Profesional 👤";
  const zoneEmoji = ZONA_EMOJI[zone] || "";

  // דחיפת ליד לתור - לצרכן חיצוני (ואידמפוטנציה ל-60 שניות)
  await enqueueLead({
    user,
    city: cityTitle,
    zone,
    service: serviceId,
    ts: Date.now(),
  });

  await sendText(
    to,
    `Listo ✅  ${serviceText} • Zona ${zone} ${zoneEmoji} • ${cityTitle}.\n` +
    `En breve te contactarán profesionales cercanos.\n\nServicio24`
  );
}

// ---------------- Webhook ----------------
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;
        const messageId = msg.id || msg?.button?.payload || `${from}:${Date.now()}`; // גיבוי זהיר

        // סינון כפילויות מה-Webhook
        const dup = await isDuplicateMessage(messageId);
        if (dup) {
          continue;
        }

        // שליפת סשן
        let s = await getSession(from);

        // FREE-TEXT: מחזיר למסך הבא הלוגי בלי reset ל-Role
        if (msg.type === "text") {
          if (!s.started) { await sendStartConfirm(from); continue; }
          const now = Date.now();
          if (!s.lastWelcome || now - s.lastWelcome > SESSION_TTL_SECONDS * 1000) {
            s.lastWelcome = now;
            await saveSession(from, s);
          }
          if (s.zoneConfirmed) {
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            await sendServicesList(from, cityTitle, s.zone);
            continue;
          }
          if (typeof s.zone === "number") { await sendZonaConfirm(from, s.zone); continue; }
          if (s.city) { await sendZonaGroupButtons(from); continue; }
          await sendCityMenu(from);
          continue;
        }

        const interactive = msg.interactive;

        // LIST_REPLY
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          // Ciudad
          if (CITIES.some(c => c.id === id)) {
            const city = CITIES.find(c => c.id === id);
            s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null;
            await saveSession(from, s);
            console.log("city_selected", { from, city: city.title });
            await sendZonaGroupButtons(from);
            continue;
          }

          // Zona exacta
          if (id?.startsWith("zona_")) {
            const z = parseInt(id.split("_")[1], 10);
            if (z >= 1 && z <= 25) {
              s.zone = z; s.zoneConfirmed = false;
              await saveSession(from, s);
              console.log("zone_selected", { from, zone: z });
              await sendZonaConfirm(from, z);
              continue;
            }
          }

          // Servicio
          if (SERVICE_LABEL[id]) {
            if (!s.zoneConfirmed) {
              await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
              await sendZonaGroupButtons(from);
              continue;
            }
            s.serviceId = id;
            await saveSession(from, s);
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("service_selected", { from, serviceId: id });
            await sendLeadReady(from, cityTitle, s.zone, s.serviceId, from);
            continue;
          }
        }

        // BUTTON_REPLY
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          // Inicio
          if (id === "start_yes") {
            s.started = true;
            await saveSession(from, s);
            await sendRoleButtons(from);
            continue;
          }
          if (id === "start_no")  {
            await sendText(from, "Operación cancelada.\n\nServicio24");
            continue;
          }

          // Rol
          if (id === "role_cliente") { await sendCityMenu(from); continue; }
          if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24"); continue; }

          // Grupos de zona
          if (id === "zona_group_1_10")  { await sendZonaList(from, 1, 10);  continue; }
          if (id === "zona_group_11_20") { await sendZonaList(from, 11, 20); continue; }
          if (id === "zona_group_21_25") { await sendZonaList(from, 21, 25); continue; }

          // Cambio o confirmación de zona
          if (id === "zona_change") { await sendZonaGroupButtons(from); continue; }
          if (id === "zona_confirm") {
            if (typeof s.zone !== "number") { await sendZonaGroupButtons(from); continue; }
            const gotLock = await acquireConfirmLock(from, 3);
            if (!gotLock) { continue; }
            s.zoneConfirmed = true;
            await saveSession(from, s);
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("zone_confirmed", { from, zone: s.zone });
            await sendServicesList(from, cityTitle, s.zone);
            continue;
          }
        }

        // Fallback אם עדיין אין עיר
        if (!s.city) {
          await sendCityMenu(from);
          continue;
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ---------------- Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [V2 Barzel Stable]`));
