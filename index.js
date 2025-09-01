// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// Servicios:
// 🚰  Plomero
// ⚡  Electricista
// 🔑  Cerrajero
// ❄️  Aire acondicionado
// 🛠️  Mecánico
// 🛻  Servicio de grúa
// 🚚  Mudanza
//
// Zonas (Ciudad de Guatemala):
// Zona 1 🏛️ | Zona 2 🍺 | Zona 3 🕊️ | Zona 4 💰 | Zona 5 🏟️
 // Zona 6 🏘️ | Zona 7 🏺 | Zona 8 🚌 | Zona 9 🏨 | Zona 10 🎉
 // Zona 11 🛒 | Zona 12 🧰 | Zona 13 ✈️ | Zona 14 🏢 | Zona 15 🎓
 // Zona 16 🏰 | Zona 17 🏭 | Zona 18 🛣️ | Zona 19 🔧 | Zona 20 🏚️
 // Zona 21 🚧 | Zona 22 📦 | Zona 23 🚋 | Zona 24 🏗️ | Zona 25 🌳

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --------- Graph API ----------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// --------- Cities & Zonas ----------
const CITIES = [
  {
    id: "GUA",
    name: "Ciudad de Guatemala",
    enabled: true,
    zonas: [
      { id: "z1",  title: "Zona 1 🏛️" },
      { id: "z2",  title: "Zona 2 🍺" },
      { id: "z3",  title: "Zona 3 🕊️" },
      { id: "z4",  title: "Zona 4 💰" },
      { id: "z5",  title: "Zona 5 🏟️" },
      { id: "z6",  title: "Zona 6 🏘️" },
      { id: "z7",  title: "Zona 7 🏺" },
      { id: "z8",  title: "Zona 8 🚌" },
      { id: "z9",  title: "Zona 9 🏨" },
      { id: "z10", title: "Zona 10 🎉" },
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
      { id: "z21", title: "Zona 21 🚧" },
      { id: "z22", title: "Zona 22 📦" },
      { id: "z23", title: "Zona 23 🚋" },
      { id: "z24", title: "Zona 24 🏗️" },
      { id: "z25", title: "Zona 25 🌳" }
    ]
  },
  // ערים נוספות ייכנסו כאן בעתיד עם enabled:false
];

// === session memory ===
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 דקות
const sessions = new Map(); // key: user -> { lastWelcome, city }

// --------- Send helpers ----------
async function sendText(to, text) {
  return axios.post(GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    AUTH
  );
}

async function sendRoleButtons(to) {
  return axios.post(GRAPH_URL,
    {
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
            { type: "reply", reply: { id: "role_tecnico", title: "Técnico" } }
          ]
        }
      }
    },
    AUTH
  );
}

// ---- City list (organic flow) ----
async function sendCityList(to) {
  const rows = CITIES
    .filter(c => c.enabled)
    .map(c => ({ id: `city_${c.id}`, title: c.name }));

  return axios.post(GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Selecciona tu ciudad" },
        body: { text: "Elige una ciudad para continuar:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir ciudad",
          sections: [{ title: "Ciudades", rows }]
        }
      }
    },
    AUTH
  );
}

// ---- Services list (uses session city in footer) ----
async function sendClientList(to, cityId) {
  const city = CITIES.find(c => c.id === cityId) || CITIES.find(c => c.enabled);
  const footerTxt = city ? `Servicio24 • ${city.name}` : "Servicio24";

  return axios.post(GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" },
        body: { text: "\n*Elige el profesional que necesitas:*" },
        footer: { text: footerTxt },
        action: {
          button: "Elegir profesional",
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
                { id: "srv_mudanza",      title: "🚚  Mudanza" }
              ]
            }
          ]
        }
      }
    },
    AUTH
  );
}

// ---- Zonas list split to <=10 per section ----
async function sendZonaList(to, cityId) {
  const city = CITIES.find(c => c.id === cityId) || CITIES.find(c => c.enabled);
  const zonas = city?.zonas || [];

  const sec1 = zonas.slice(0, 10).map(z => ({ id: z.id, title: z.title }));   // 1–10
  const sec2 = zonas.slice(10, 20).map(z => ({ id: z.id, title: z.title }));  // 11–20
  const sec3 = zonas.slice(20).map(z => ({ id: z.id, title: z.title }));      // 21–25

  const sections = [];
  if (sec1.length) sections.push({ title: "Zonas 1–10", rows: sec1 });
  if (sec2.length) sections.push({ title: "Zonas 11–20", rows: sec2 });
  if (sec3.length) sections.push({ title: "Zonas 21–25", rows: sec3 });

  return axios.post(GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: `Zonas - ${city?.name || "Ciudad"}` },
        body: { text: "*Elige tu zona específica:*" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir zona",
          sections
        }
      }
    },
    AUTH
  );
}

// ---- After service selection -> ask Zona ----
async function handleProfession(to, id, cityId) {
  const map = {
    srv_plomero: "Plomero",
    srv_electricista: "Electricista",
    srv_cerrajero: "Cerrajero",
    srv_aire: "Aire acondicionado",
    srv_mecanico: "Mecánico",
    srv_grua: "Servicio de grúa",
    srv_mudanza: "Mudanza"
  };
  const name = map[id] || "Profesional";

  await sendText(
    to,
    `*Perfecto*, seleccionaste: *${name}*.\n\nAhora selecciona tu zona para encontrar proveedores cercanos.`
  );
  await sendZonaList(to, cityId);
}

// --------- Webhook: GET ----------
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

// --------- Webhook: POST ----------
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from;
        const now  = Date.now();

        // ensure session
        const sess = sessions.get(from) || { city: "GUA" };
        sessions.set(from, sess);

        // 1) Free text -> role menu (throttled)
        if (msg.type === "text") {
          const throttled = sess.lastWelcome && (now - sess.lastWelcome <= SESSION_TTL_MS);
          if (!throttled) {
            await sendRoleButtons(from);
            sessions.set(from, { ...sess, lastWelcome: now });
          }
          continue;
        }

        // 2) Interactive replies
        const interactive = msg.interactive;

        // 2a) Buttons (organic flow)
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply.id;

          if (id === "role_cliente") {
            // אורגני: תמיד תפריט ערים
            await sendCityList(from);
            sessions.set(from, { ...sess, lastWelcome: now });
            continue;
          }

          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            sessions.set(from, { ...sess, lastWelcome: now });
            continue;
          }
        }

        // 2b) Lists (city / service / zona)
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply.id;

          // City chosen
          if (id.startsWith("city_")) {
            const cityId = id.replace("city_", "");
            sessions.set(from, { ...sess, city: cityId, lastWelcome: now });
            await sendClientList(from, cityId);
            continue;
          }

          // Service chosen
          if (id.startsWith("srv_")) {
            const cityId = sessions.get(from)?.city || "GUA";
            await handleProfession(from, id, cityId);
            sessions.set(from, { ...sess, lastWelcome: now });
            continue;
          }

          // Zona chosen
          if (/^z\d{1,2}$/.test(id)) {
            await sendText(from, `Zona confirmada: *${id.toUpperCase()}*.\nEn breve te contactarán 1–3 proveedores cercanos.`);
            sessions.set(from, { ...sess, lastWelcome: now });
            continue;
          }
        }
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
