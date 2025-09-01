// index.js
// === Servicio24: emojis oficiales (LOCKED) ===
// Servicios: 🚰 Plomero | ⚡ Electricista | 🔑 Cerrajero | ❄️ Aire acondicionado | 🛠️ Mecánico | 🛻 Servicio de grúa | 🚚 Mudanza
// Zonas 1-25:
// 1 🏛️ | 2 🍺 | 3 🕊️ | 4 💰 | 5 🏟️ | 6 🏘️ | 7 🏺 | 8 🚌 | 9 🏨 | 10 🎉 |
// 11 🛒 | 12 🧰 | 13 ✈️ | 14 🏢 | 15 🎓 | 16 🏰 | 17 🏭 | 18 🛣️ | 19 🔧 | 20 🏚️ |
// 21 🚧 | 22 📦 | 23 🚋 | 24 🏗️ | 25 🌳

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --------- Consts / Helpers ----------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
// session: { city, zone, zoneConfirmed, serviceId, awaiting, lastWelcome }
const sessions = new Map();

// ---- City catalog (expand later) ----
const CITIES = [{ id: "city_guatemala", title: "Ciudad de Guatemala" }];

// ---- Services ----
const SERVICE_LABEL = {
  srv_plomero: "Plomero",
  srv_electricista: "Electricista",
  srv_cerrajero: "Cerrajero",
  srv_aire: "Aire acondicionado",
  srv_mecanico: "Mecánico",
  srv_grua: "Servicio de grúa",
  srv_mudanza: "Mudanza",
};

// ---- Zona emojis (locked) ----
const ZONA_EMOJI = {
  1:"🏛️",2:"🍺",3:"🕊️",4:"💰",5:"🏟️",6:"🏘️",7:"🏺",8:"🚌",9:"🏨",10:"🎉",
  11:"🛒",12:"🧰",13:"✈️",14:"🏢",15:"🎓",16:"🏰",17:"🏭",18:"🛣️",19:"🔧",20:"🏚️",
  21:"🚧",22:"📦",23:"🚋",24:"🏗️",25:"🌳"
};

// --------- Senders ----------
function sendText(to, text) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "text", text: { body: text },
  }, AUTH);
}

// role (Cliente/Técnico)
function sendRoleButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Bienvenido a Servicio24" },
      body:   { text: "*Selecciona tu rol:*\n" },
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

// city list
function sendCityMenu(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Selecciona tu ciudad" },
      body:   { text: "Elige la ciudad donde necesitas el servicio:" },
      footer: { text: "Servicio24" },
      action: {
        button: "Elegir ciudad",
        sections: [
          { title: "Ciudades", rows: CITIES.map(c => ({ id: c.id, title: c.title })) }
        ]
      }
    }
  }, AUTH);
}

// zona groups 1-10 / 11-20 / 21-25
function sendZonaGroupButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Zonas" },
      body:   { text: "Elige tu zona exacta:" },
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

// exact zona list
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) {
    rows.push({ id: `zona_${z}`, title: `${ZONA_EMOJI[z]}  Zona ${z}` });
  }
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Zonas ${start}-${end}` },
      body:   { text: "Elige tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Elegir zona", sections: [{ title: "Zonas", rows }] }
    }
  }, AUTH);
}

// confirm zona (no consent here)
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// services list (after zona confirmed) — consent in short footer (≤60 chars)
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body:   { text: `Elige el profesional que necesitas:\n${cityTitle} • Zona ${z} ${zEmoji}` },
      footer: { text: "Servicio24 · Aceptas llamadas y mensajes. Sin costo." },
      action: {
        button: "Elegir servicio",
        sections: [
          {
            title: "Profesionales",
            rows: [
              { id: "srv_plomero",      title: "🚰  Plomero" },
              { id: "srv_electricista", title: "⚡  Electricista" },
              { id: "srv_cerrajero",    title: "🔑  Cerrajero" },
              { id: "srv_aire",         title: "❄️  Aire acondicionado" },
              { id: "srv_mecanico",     title: "🛠️  Mecánico" },
              { id: "srv_grua",         title: "🛻  Servicio de grúa" },
              { id: "srv_mudanza",      title: "🚚  Mudanza" },
            ]
          }
        ]
      }
    }
  }, AUTH);
}

// final lead message
function sendLeadReady(to, cityTitle, zone, serviceId) {
  const service = SERVICE_LABEL[serviceId] || "Profesional";
  const emoji = ZONA_EMOJI[zone] || "";
  const text = `Listo ✅  ${service} • Zona ${zone} ${emoji} • ${cityTitle}.\nEn breve te contactarán profesionales.`;
  return sendText(to, text);
}

// --------- Webhook: GET (verify) ----------
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// --------- Webhook: POST (messages) ----------
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;
        const s = sessions.get(from) || { city: null, zone: null, zoneConfirmed: false, serviceId: null, awaiting: null, lastWelcome: 0 };
        sessions.set(from, s);

        // --- TEXT FALLBACKS ---
        if (msg.type === "text") {
          const txt = (msg.text?.body || "").trim().toLowerCase();

          // awaiting zone confirm
          if (s.awaiting === "zona_confirm") {
            if (txt === "confirmar" || txt === "confirmar ✅") {
              s.zoneConfirmed = true; s.awaiting = null;
              const cityTitle = s.city?.title || "Ciudad de Guatemala";
              await sendServicesList(from, cityTitle, s.zone);
              continue;
            }
            if (txt === "cambiar" || txt === "cambiar zona") {
              s.zoneConfirmed = false; s.awaiting = null;
              await sendZonaGroupButtons(from);
              continue;
            }
            const n = parseInt(txt, 10);
            if (!isNaN(n) && n >= 1 && n <= 25) {
              s.zone = n; s.zoneConfirmed = false; s.awaiting = "zona_confirm";
              await sendZonaConfirm(from, n);
              continue;
            }
          }

          // idle -> role
          const now = Date.now();
          if (!s.lastWelcome || now - s.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            s.lastWelcome = now;
          }
          continue;
        }

        const interactive = msg.interactive;

        // list replies
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          // city chosen
          if (CITIES.some(c => c.id === id)) {
            const city = CITIES.find(c => c.id === id);
            s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null; s.awaiting = null;
            await sendZonaGroupButtons(from);
            continue;
          }

          // exact zona chosen
          if (id?.startsWith("zona_")) {
            const z = parseInt(id.split("_")[1], 10);
            if (z >= 1 && z <= 25) {
              s.zone = z; s.zoneConfirmed = false; s.awaiting = "zona_confirm";
              await sendZonaConfirm(from, z);
              continue;
            }
          }

          // service chosen
          if (SERVICE_LABEL[id]) {
            s.serviceId = id;
            if (s.zoneConfirmed) {
              const cityTitle = s.city?.title || "Ciudad de Guatemala";
              await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
              continue;
            }
            await sendZonaGroupButtons(from);
            continue;
          }
        }

        // button replies
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          // roles
          if (id === "role_cliente") { await sendCityMenu(from); continue; }
          if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción…"); continue; }

          // zona groups
          if (id === "zona_group_1_10")  { await sendZonaList(from, 1, 10);  continue; }
          if (id === "zona_group_11_20") { await sendZonaList(from, 11, 20); continue; }
          if (id === "zona_group_21_25") { await sendZonaList(from, 21, 25); continue; }

          // confirm / change zona
          if (id === "zona_change") {
            s.zoneConfirmed = false; s.awaiting = null;
            await sendZonaGroupButtons(from); continue;
          }
          if (id === "zona_confirm") {
            if (!s.zone) { await sendZonaGroupButtons(from); continue; }
            s.zoneConfirmed = true; s.awaiting = null;
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            await sendServicesList(from, cityTitle, s.zone);
            continue;
          }
        }

        // fallback: if no city yet, start at city menu
        if (!s.city) { await sendCityMenu(from); continue; }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// --------- Server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
