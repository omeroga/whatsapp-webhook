// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===== Helpers / Consts =====
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// Send plain text
async function sendText(to, text) {
  return axios.post(
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

// Send 2-button message (role selection)
async function sendButtons(to, { header, body, buttons }) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header, // { type: "text", text: "..." }
        body,   // { text: "..." }
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title }, // אין עיצוב בטייטל
          })),
        },
      },
    },
    AUTH
  );
}

// Send client services list (up to 10 rows, each title ≤ 24 chars)
async function sendClientList(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" }, // Header מודגש אוטומטית
        body: { text: "**Selecciona el profesional que necesitas:**" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir",
          sections: [
            {
              title: "Profesionales",
              rows: [
                { id: "pro_electricista",      title: "⚡ Electricista" },
                { id: "pro_plomero",           title: "🚰 Plomero" },
                { id: "pro_cerrajero",         title: "🔑 Cerrajero" },
                { id: "pro_vidriero",          title: "🪟 Vidriero" },
                { id: "pro_electrodomesticos", title: "🔧 Electrodomésticos" },
                { id: "pro_tapicero",          title: "🪑 Tapicero" },
                { id: "pro_carpintero",        title: "🪚 Carpintero" },
                { id: "pro_mecanico",          title: "🛠️ Mecánico" },
                { id: "pro_grua",              title: "🚛 Grúa" },
                { id: "pro_tecnologia",        title: "💻 Tecnología" },
              ],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// ===== GET /webhook (verification from Meta console) =====
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

// ===== POST /webhook (receive & respond) =====
app.post("/webhook", async (req, res) => {
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          const from = msg.from;

          // Handle interactive replies
          if (msg.type === "interactive") {
            const interactive = msg.interactive || {};
            // Button reply (role selection)
            if (interactive.type === "button_reply") {
              const { id } = interactive.button_reply || {};
              if (id === "role_cliente") {
                await sendClientList(from);
                continue;
              }
              if (id === "role_tecnico") {
                await sendText(from, "Función de **Técnico** en construcción…");
                continue;
              }
            }
            // List reply (service chosen) – placeholder
            if (interactive.type === "list_reply") {
              const { id } = interactive.list_reply || {};
              await sendText(from, `Recibido: ${id}. Próximo paso en construcción…`);
              continue;
            }
          }

          // Any other incoming message -> show welcome + role buttons
          await sendButtons(from, {
            header: { type: "text", text: "Bienvenido a **Servicio24**" },
            body: { text: "**Selecciona tu rol:**" },
            buttons: [
              { id: "role_cliente", title: "Cliente" },
              { id: "role_tecnico", title: "Técnico" },
            ],
          });
        }
      }
    }

    // Always 200 so Meta won't retry
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// ===== Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
