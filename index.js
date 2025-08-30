// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- helpers / consts ---
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// --- פונקציה לשליחת טקסט פשוט ---
async function sendText(to, text) {
  await axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    AUTH
  );
}

// --- פונקציה לשליחת תפריט ללקוח ---
async function sendClientList(to) {
  await axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "Servicios disponibles", // בלי Markdown
        },
        body: {
          text: "*Selecciona el profesional que necesitas:*", // כאן מותר Bold
        },
        footer: {
          text: "Servicio24",
        },
        action: {
          button: "Elegir",
          sections: [
            {
              title: "Profesionales",
              rows: [
                { id: "role_electricista", title: "⚡ Electricista" },
                { id: "role_fontanero", title: "🚰 Fontanero" },
                { id: "role_cerrajero", title: "🔑 Cerrajero" },
                { id: "role_vidriero", title: "🪟 Vidriero" },
                { id: "role_albanil", title: "🧱 Albañil" },
                { id: "role_carpintero", title: "🪚 Carpintero" },
                { id: "role_mecanico", title: "🔧 Mecánico" },
                { id: "role_grua", title: "🚚 Grúa" },
              ],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// --- GET /webhook - verification (Meta console) ---
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

// --- POST /webhook - receive messages & auto-reply ---
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;
        const id = msg.interactive?.list_reply?.id;

        // אם המשתמש בחר "Cliente"
        if (id === "role_cliente") {
          await sendClientList(from);
          continue;
        }

        // אם המשתמש בחר "Técnico"
        if (id === "role_tecnico") {
          await sendText(from, "Función de *Técnico* en construcción...");
          continue;
        }

        // ברירת מחדל – הודעת פתיחה
        if (msg.type === "text") {
          await axios.post(
            GRAPH_URL,
            {
              messaging_product: "whatsapp",
              to: from,
              type: "interactive",
              interactive: {
                type: "button",
                body: {
                  text: "Bienvenido a *Servicio24*\n\n*Selecciona tu rol:*",
                },
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
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// --- server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
