// index.js
// === Servicio24: V2 (Cliente, HOTFIX: free-text routing) ===
// Plomero 🚰 | Electricista ⚡ | Cerrajero 🔑 | Aire acondicionado ❄️ | Mecánico 🛠️ | Servicio de grúa 🛻 | Mudanza 🚚
/* Zonas 1-25 (LOCKED) ... */

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

const SESSION_TTL_MS = 30 * 60 * 1000; // שמור לעתיד, לא משתמשים בו ל-reset אוטומטי
const sessions = new Map();

const lastConfirmByUser = new Map();
function canConfirmOnce(userId, ms = 2500) {
  const now = Date.now();
  const last = lastConfirmByUser.get(userId) ?? 0;
  if (now - last < ms) return false;
  lastConfirmByUser.set(userId, now);
  return true;
}

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

// ---- Send helpers ----
function sendText(to, text) {
  return axios.post(GRAPH_URL, { messaging_product: "whatsapp", to, type: "text", text: { body: text } }, AUTH);
}
function sendStartConfirm(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
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
  }, AUTH);
}
function sendRoleButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
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
  }, AUTH);
}
function sendCityMenu(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Selecciona tu ciudad" },
      body:   { text: "Elige la ciudad donde necesitas el servicio:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar ciudad", sections: [{ title: "Ciudades", rows: CITIES.map(c => ({ id: c.id, title: c.title })) }] }
    }
  }, AUTH);
}
function sendZonaGroupButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
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
  }, AUTH);
}
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) rows.push({ id: `zona_${z}`, title: `Zona ${z} ${ZONA_EMOJI[z] || ""}` });
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body:   { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Seleccionar zona", sections: [{ title: "Zonas", rows }] }
    }
  }, AUTH);
}
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
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
  }, AUTH);
}
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas recibir llamadas y mensajes de profesionales. Sin costo._";
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp", to, type: "interactive",
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
  }, AUTH);
}
async function sendLeadReady(to, cityTitle, zone, serviceId) {
  const s = SERVICES.find(x => x.id === serviceId);
  const serviceText = s ? `${s.label} ${s.emoji}` : "Profesional 👤";
  const zoneEmoji = ZONA_EMOJI[zone] || "";
  await sendText(to,
    `Listo ✅  ${serviceText} • Zona ${zone} ${zoneEmoji} • ${cityTitle}.\n` +
    `En breve te contactarán profesionales cercanos.\n\nServicio24`
  );
}

// ---- Webhook ----
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;
        const s = sessions.get(from) || { city: null, zone: null, zoneConfirmed: false, serviceId: null, lastWelcome: 0, started: false };
        sessions.set(from, s);

        // FREE-TEXT HOTFIX: מחזיר למסך הבא הלוגי לפי הסטייט, בלי reset ל-Role
        if (msg.type === "text") {
          if (!s.started) { await sendStartConfirm(from); continue; }
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

        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          if (CITIES.some(c => c.id === id)) {
            const city = CITIES.find(c => c.id === id);
            s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null;
            console.log("city_selected", { from, city: city.title });
            await sendZonaGroupButtons(from);
            continue;
          }

          if (id?.startsWith("zona_")) {
            const z = parseInt(id.split("_")[1], 10);
            if (z >= 1 && z <= 25) {
              s.zone = z; s.zoneConfirmed = false;
              console.log("zone_selected", { from, zone: z });
              await sendZonaConfirm(from, z);
              continue;
            }
          }

          if (SERVICE_LABEL[id]) {
            if (!s.zoneConfirmed) {
              await sendText(from, "Primero selecciona y confirma tu zona para continuar.");
              await sendZonaGroupButtons(from);
              continue;
            }
            s.serviceId = id;
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("service_selected", { from, serviceId: id });
            await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
            continue;
          }
        }

        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          if (id === "start_yes") { s.started = true; await sendRoleButtons(from); continue; }
          if (id === "start_no")  { await sendText(from, "Operación cancelada.\n\nServicio24"); continue; }

          if (id === "role_cliente") { await sendCityMenu(from); continue; }
          if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción...\n\nServicio24"); continue; }

          if (id === "zona_group_1_10")  { await sendZonaList(from, 1, 10);  continue; }
          if (id === "zona_group_11_20") { await sendZonaList(from, 11, 20); continue; }
          if (id === "zona_group_21_25") { await sendZonaList(from, 21, 25); continue; }

          if (id === "zona_change") { await sendZonaGroupButtons(from); continue; }
          if (id === "zona_confirm") {
            if (!s.zone) { await sendZonaGroupButtons(from); continue; }
            if (!canConfirmOnce(from)) { continue; }
            s.zoneConfirmed = true;
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("zone_confirmed", { from, zone: s.zone });
            await sendServicesList(from, cityTitle, s.zone);
            continue;
          }
        }

        if (!s.city) { await sendCityMenu(from); continue; }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
