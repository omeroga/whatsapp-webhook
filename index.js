// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------- consts / helpers ----------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

async function sendText(to, body) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    AUTH
  );
}

// הודעת פתיחה (רווחים ובולד בשתי השורות)
async function sendButtons(to) {
  const body = "*Bienvenido a Servicio24*\n\n*Selecciona tu rol:*";
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: [
            { type: "reply", reply: { id: "role_cliente", title: "Cliente" } },
            { type: "reply", reply: { id: "role_tecnico", title: "Técnico" } },
          ],
        },
      },
    },
    AUTH
  );
}

// תפריט לקוח – 7 ספקים, רווח שורה מה-header, בולד ב-body
async function sendClientList(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" }, // בלי Markdown
        body: { text: "\n*Elige el profesional que necesitas:*" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir",
          sections: [
            {
              title: "Profesionales",
              rows: [
                { id: "srv_plomero",      title: "🚰 Plomero" },
                { id: "srv_electricista", title: "⚡ Electricista" },
                { id: "srv_cerrajero",    title: "🔑 Cerrajero" },
                { id: "srv_aire",         title: "❄️ Aire Acond." },
                { id: "srv_mecanico",     title: "🔧 Mecánico" },
                { id: "srv_grua",         title: "🛻 Servicio de grúa" },
                { id: "srv_mudanza",      title: "🚚 Mudanza" }
              ],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// תגובת אישור לפי בחירה
async function handleProfession(to, id) {
  const map = {
    srv_plomero: "🚰 Plomero",
    srv_electricista: "⚡ Electricista",
    srv_cerrajero: "🔑 Cerrajero",
    srv_aire: "❄️ Aire acondicionado",
    srv_mecanico: "🔧 Mecánico",
    srv_grua: "🛻 Servicio de grúa",
    srv_mudanza: "🚚 Mudanza",
  };
  const name = map[id] || "Profesional";
  return sendText(
    to,
    `Perfecto, seleccionaste: *${name}*.\n\nEn breve te contactarán los técnicos disponibles…`
  );
}

// ---------- GET /webhook (verification) ----------
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- POST /webhook (events) ----------
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;

        // אינטראקטיב: כפתורים/רשימה
        if (msg.type === "interactive") {
          const btn = msg.interactive?.button_reply;
          const list = msg.interactive?.list_reply;

          if (btn?.id === "role_cliente") {
            await sendClientList(from);
            continue;
          }
          if (btn?.id === "role_tecnico") {
            await sendText(from, "Función de *Técnico* en construcción…");
            continue;
          }
          if (list?.id) {
            await handleProfession(from, list.id);
            continue;
          }
        }

        // ברירת מחדל: כל טקסט פותח את בחירת התפקיד
        if (msg.type === "text") {
          await sendButtons(from);
          continue;
        }
      }
    }

    return res.sendStatus(200); // תמיד 200 כדי למנוע ריטריים
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ---------- server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
