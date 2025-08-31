// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// 🚰  Plomero
// ⚡  Electricista
// 🔑  Cerrajero
// ❄️  Aire acondicionado
// 🛠️  Mecánico
// 🛻  Servicio de grúa
// 🚚  Mudanza
//
// === Zonas emojis ===
// Zona 1 🏛️   Zona 2 🍺   Zona 3 🕊️   Zona 4 💰   Zona 5 🏟️
// Zona 6 🏘️   Zona 7 🏺   Zona 8 🚌   Zona 9 🏨   Zona 10 🎉
// Zona 11 🛒   Zona 12 🧰   Zona 13 ✈️   Zona 14 🏢   Zona 15 🎓
// Zona 16 🏰   Zona 17 🏭   Zona 18 🛣️   Zona 19 🔧   Zona 20 🏚️
// Zona 21 🚧   Zona 22 📦   Zona 23 🚋   Zona 24 🏗️   Zona 25 🌳

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

// === session memory ===
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();

// ---- Helpers ----
async function sendText(to, text) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  }, AUTH);
}

async function sendRoleButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Bienvenido a Servicio24" },
      body: { text: "*Selecciona tu rol:*\n" },
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

async function sendClientList(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Servicios disponibles" },
      body: { text: "\n*Elige el profesional que necesitas:*" },
      footer: { text: "Servicio24" },
      action: {
        button: "Elegir",
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
            ],
          },
        ],
      },
    },
  }, AUTH);
}

// ---- Zona groups ----
async function sendZonaGroupButtons(to) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Selecciona tu zona" },
      body: { text: "Elige el rango de zona correspondiente:" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "zona_group_1_10", title: "Zona 1–10" } },
          { type: "reply", reply: { id: "zona_group_11_20", title: "Zona 11–20" } },
          { type: "reply", reply: { id: "zona_group_21_25", title: "Zona 21–25" } },
        ],
      },
    },
  }, AUTH);
}

// ---- Zona lists (submenus) ----
async function sendZonaList(to, groupId) {
  let rows = [];
  if (groupId === "zona_group_1_10") {
    rows = [
      { id: "z1", title: "Zona 1 🏛️" },
      { id: "z2", title: "Zona 2 🍺" },
      { id: "z3", title: "Zona 3 🕊️" },
      { id: "z4", title: "Zona 4 💰" },
      { id: "z5", title: "Zona 5 🏟️" },
      { id: "z6", title: "Zona 6 🏘️" },
      { id: "z7", title: "Zona 7 🏺" },
      { id: "z8", title: "Zona 8 🚌" },
      { id: "z9", title: "Zona 9 🏨" },
      { id: "z10", title: "Zona 10 🎉" },
    ];
  }
  if (groupId === "zona_group_11_20") {
    rows = [
      { id: "z11", title: "Zona 11 🛒" },
      { id: "z12", title: "Zona 12 🧰" },
      { id: "z13", title: "Zona 13 ✈️" },
      { id: "z14", title: "Zona 14 🏢" },
      { id: "z15", title: "Zona 15 🎓" },
      { id: "z16", title: "Zona 16 🏰" },
      { id: "z17", title: "Zona 17 🏭" },
      { id: "z18", title: "Zona 18 🛣️" },
      { id: "z19", title: "Zona 19 🔧" },
      { id: "z20", title: "Zona 20 🏚️" },
    ];
  }
  if (groupId === "zona_group_21_25") {
    rows = [
      { id: "z21", title: "Zona 21 🚧" },
      { id: "z22", title: "Zona 22 📦" },
      { id: "z23", title: "Zona 23 🚋" },
      { id: "z24", title: "Zona 24 🏗️" },
      { id: "z25", title: "Zona 25 🌳" },
    ];
  }

  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Zonas disponibles" },
      body: { text: "Selecciona tu zona exacta:" },
      footer: { text: "Servicio24" },
      action: { button: "Elegir", sections: [{ title: "Zonas", rows }] },
    },
  }, AUTH);
}

// ---- Confirm / Change ----
async function sendZonaConfirm(to, zonaId, zonaTitle) {
  return axios.post(GRAPH_URL, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: `Has seleccionado ${zonaTitle}` },
      body: { text: "¿Quieres confirmar esta zona o cambiarla?" },
      footer: { text: "Servicio24" },
      action: {
        buttons: [
          { type: "reply", reply: { id: `confirm_${zonaId}`, title: "✅ Confirmar" } },
          { type: "reply", reply: { id: "change_zona", title: "🔄 Cambiar zona" } },
        ],
      },
    },
  }, AUTH);
}

// ---- Profesiones ----
async function handleProfession(to, id) {
  const map = {
    srv_plomero: "Plomero",
    srv_electricista: "Electricista",
    srv_cerrajero: "Cerrajero",
    srv_aire: "Aire acondicionado",
    srv_mecanico: "Mecánico",
    srv_grua: "Servicio de grúa",
    srv_mudanza: "Mudanza",
  };

  const name = map[id] || "Profesional";
  await sendText(to, `*Perfecto*, seleccionaste: *${name}*.`);
  await sendZonaGroupButtons(to);
}

// ---- Intent detection ----
const SERVICE_WORDS = {
  plomero: "srv_plomero",
  electricista: "srv_electricista",
  cerrajero: "srv_cerrajero",
  aire: "srv_aire",
  mecanico: "srv_mecanico",
  mecánico: "srv_mecanico",
  grua: "srv_grua",
  grúa: "srv_grua",
  mudanza: "srv_mudanza",
};

function parseOriginAndIntent(msg) {
  const out = { source: "organic", serviceId: null, zone: null };
  if (msg.referral) {
    out.source = "paid";
    extractFromText(msg.text?.body || "", out);
    return out;
  }
  if (msg.type === "text") {
    extractFromText(msg.text?.body || "", out);
  }
  return out;
}

function extractFromText(text, out) {
  const low = (text || "").toLowerCase();
  for (const key of Object.keys(SERVICE_WORDS)) {
    if (low.includes(`#${key}`)) {
      out.serviceId = SERVICE_WORDS[key];
      break;
    }
  }
  const zMatch = low.match(/\b(?:zona\s*)?z?(\d{1,2})\b/);
  if (zMatch) {
    const n = parseInt(zMatch[1], 10);
    if (n >= 1 && n <= 25) out.zone = `z${n}`;
  }
  if (out.serviceId || out.zone) out.source = "paid";
}

// ---- Webhooks ----
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from;
        const interactive = msg.interactive;

        // --- Paid vs Organic ---
        const intent = parseOriginAndIntent(msg);
        if (intent.source === "paid") {
          if (intent.serviceId) await handleProfession(from, intent.serviceId);
          else await sendClientList(from);
          sessions.set(from, { lastWelcome: Date.now() });
          continue;
        }

        // --- Free text ---
        if (msg.type === "text") {
          const now = Date.now();
          const session = sessions.get(from);
          if (!session || now - session.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { lastWelcome: now });
          }
          continue;
        }

        // --- Button reply ---
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;
          if (id === "role_cliente") { await sendClientList(from); continue; }
          if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción…"); continue; }
          if (id.startsWith("zona_group_")) { await sendZonaList(from, id); continue; }
          if (id.startsWith("confirm_")) { await sendText(from, "✅ Zona confirmada. En breve te contactarán proveedores."); continue; }
          if (id === "change_zona") { await sendZonaGroupButtons(from); continue; }
        }

        // --- List reply ---
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;
          const title = interactive.list_reply?.title;
          if (id?.startsWith("srv_")) { await handleProfession(from, id); continue; }
          if (id?.startsWith("z")) { await sendZonaConfirm(from, id, title); continue; }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
