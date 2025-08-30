// index.js
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

// Send plain text
async function sendText(to, text) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    AUTH
  );
}

// Opening buttons: Cliente / Técnico
async function sendRoleButtons(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Bienvenido a Servicio24" }, // ללא Markdown
        body: { text: "*Selecciona tu rol:*\n" }, // Bold + רווח שורה מהכותרת
        action: {
          buttons: [
            { type: "reply", reply: { id: "role_cliente", title: "Cliente" } },
            { type: "reply", reply: { id: "role_tecnico", title: "Técnico" } },
          ],
        },
        footer: { text: "Servicio24" },
      },
    },
    AUTH
  );
}

// List for Cliente: 7 מקצועות עם אימוג'ים נכונים
async function sendClientList(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" }, // ללא Markdown
        body: { text: "\n*Elige el profesional que necesitas:*" }, // רווח שורה לפני ה-body + Bold
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
    },
    AUTH
  );
}

// לאחר בחירת מקצוע – אישור קצר ללקוח
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

  return sendText(
    to,
    `*Perfecto*, seleccionaste: *${name}*.\n\nEn breve te contactarán 1–3 proveedores cercanos.`
  );
}

// --------- Webhook: GET (verify) ----------
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
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

        // 1) טקסט חופשי -> תפריט תפקידים
        if (msg.type === "text") {
          await sendRoleButtons(from);
          continue;
        }

        // 2) תגובת כפתור
        const interactive = msg.interactive;
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          if (id === "role_cliente") {
            await sendClientList(from);
            continue;
          }

          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            continue;
          }
        }

        // 3) תגובת רשימה (בחירת מקצוע)
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;
          if (id?.startsWith("srv_")) {
            await handleProfession(from, id);
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
