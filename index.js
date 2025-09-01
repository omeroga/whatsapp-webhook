// index.js
// === Servicio24: V2 (Cliente, cleaned sobre V1 BRONZE LOCKED) ===
// Servicios oficiales (LOCKED):
// Plomero 🚰 | Electricista ⚡ | Cerrajero 🔑 | Aire acondicionado ❄️ | Mecánico 🛠️ | Servicio de grúa 🛻 | Mudanza 🚚
/* Zonas 1-25 (LOCKED):
1 🏛️ | 2 🍺 | 3 🕊️ | 4 💰 | 5 🏟️ | 6 🏘️ | 7 🏺 | 8 🚌 | 9 🏨 | 10 🎉 |
11 🛒 | 12 🧰 | 13 ✈️ | 14 🏢 | 15 🎓 | 16 🏰 | 17 🏭 | 18 🛣️ | 19 🔧 | 20 🏚️ |
21 🚧 | 22 📦 | 23 🚋 | 24 🏗️ | 25 🌳
*/

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------------- Config ----------------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// Sesiones en memoria
const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

// Anti double tap en Confirmar
const lastConfirmByUser = new Map();
function canConfirmOnce(userId, ms = 2500) {
  const now = Date.now();
  const last = lastConfirmByUser.get(userId) ?? 0;
  if (now - last < ms) return false;
  lastConfirmByUser.set(userId, now);
  return true;
}

// ---------------- Datos LOCKED ----------------
const CITIES = [{ id: "city_guatemala", title: "Ciudad de Guatemala" }];

// Tabla de hierro para servicios: solo cambiamos la posición visual del emoji
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

// ---------------- Helpers de envío ----------------
function sendText(to, text) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  }, AUTH);
}

// pantalla inicial: confirmación
function sendStartConfirm(to) {
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// role (Cliente/Técnico)
function sendRoleButtons(to) {
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// city list
function sendCityMenu(to) {
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// zona groups
function sendZonaGroupButtons(to) {
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// zona list exacta
function sendZonaList(to, start, end) {
  const rows = [];
  for (let z = start; z <= end; z++) {
    const label = `Zona ${z} ${ZONA_EMOJI[z] || ""}`; // palabra y luego emoji
    rows.push({ id: `zona_${z}`, title: label });
  }
  return axios.post(GRAPH_URL, {
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
  }, AUTH);
}

// confirm zona
function sendZonaConfirm(to, z) {
  const emoji = ZONA_EMOJI[z] || "";
  const headerText = `Zona seleccionada: ${z} ${emoji}`;

  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: headerText },
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

// services list — mostramos "nombre + emoji" (emoji a la derecha)
function sendServicesList(to, cityTitle, z) {
  const zEmoji = ZONA_EMOJI[z] || "";
  const consent = "_Al continuar, aceptas recibir llamadas y mensajes de profesionales. Sin costo._";
  return axios.post(GRAPH_URL, {
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
            rows: SERVICES.map(s => ({
              id: s.id,
              title: `${s.label} ${s.emoji}` // palabra y luego emoji
            }))
          }
        ]
      }
    }
  }, AUTH);
}

// final lead — mostramos "nombre + emoji"
async function sendLeadReady(to, cityTitle, zone, serviceId) {
  const serviceObj = SERVICES.find(s => s.id === serviceId);
  const serviceText = serviceObj ? `${serviceObj.label} ${serviceObj.emoji}` : "Profesional 👤";
  const zoneEmoji = ZONA_EMOJI[zone] || "";
  const text =
    `Listo ✅  ${serviceText} • Zona ${zone} ${zoneEmoji} • ${cityTitle}.\n` +
    `En breve te contactarán profesionales cercanos.\n\nServicio24`;
  await sendText(to, text);
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

        // Restaurar o crear sesión
        const s = sessions.get(from) || {
          city: null,
          zone: null,
          zoneConfirmed: false,
          serviceId: null,
          lastWelcome: 0,
          started: false
        };
        sessions.set(from, s);

        // Mensaje de texto libre
        if (msg.type === "text") {
          if (!s.started) { await sendStartConfirm(from); continue; }
          const now = Date.now();
          if (!s.lastWelcome || now - s.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            s.lastWelcome = now;
          }
          continue;
        }

        const interactive = msg.interactive;

        // Respuestas de listas
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          // Ciudad
          if (CITIES.some(c => c.id === id)) {
            const city = CITIES.find(c => c.id === id);
            s.city = city; s.zone = null; s.zoneConfirmed = false; s.serviceId = null;
            console.log("city_selected", { from, city: city.title });
            await sendZonaGroupButtons(from);
            continue;
          }

          // Zona exacta
          if (id?.startsWith("zona_")) {
            const z = parseInt(id.split("_")[1], 10);
            if (z >= 1 && z <= 25) {
              s.zone = z; s.zoneConfirmed = false;
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
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("service_selected", { from, serviceId: id });
            await sendLeadReady(from, cityTitle, s.zone, s.serviceId);
            continue;
          }
        }

        // Respuestas de botones
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          // Inicio
          if (id === "start_yes") { s.started = true; await sendRoleButtons(from); continue; }
          if (id === "start_no")  { await sendText(from, "Operación cancelada.\n\nServicio24"); continue; }

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
            if (!s.zone) { await sendZonaGroupButtons(from); continue; }
            if (!canConfirmOnce(from)) { continue; } // evita doble confirm
            s.zoneConfirmed = true;
            const cityTitle = s.city?.title || "Ciudad de Guatemala";
            console.log("zone_confirmed", { from, zone: s.zone });
            // Siempre avanzar a servicios después de confirmar zona
            await sendServicesList(from, cityTitle, s.zone);
            continue;
          }
        }

        // Fallback por si no hay ciudad aún
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
