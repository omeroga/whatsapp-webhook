// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- helpers / consts ---
const API_VERSION = (process.env.GRAPH_VERSION || "23.0").replace(/^v/i, "");
const GRAPH_URL = `https://graph.facebook.com/v${API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// פונקציית עזר לשליחת כפתורים
async function sendButtons(to, bodyText, buttons) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map(b => ({ type: "reply", reply: b })) },
      },
    },
    AUTH
  );
}

// פונקציית עזר לשליחת ליסט של בעלי מקצוע
async function sendClientList(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" },
        body: { text: "Selecciona el profesional que necesitas:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir",
          sections: [
            {
              title: "Profesionales",
              rows: [
                { id: "srv_plomero", title: "🚰 Plomero" },
                { id: "srv_electricista", title: "💡 Electricista" },
                { id: "srv_cerrajero", title: "🔑 Cerrajero" },
                { id: "srv_mecanico", title: "🛠️ Mecánico" },
                { id: "srv_grua", title: "🚗 Grúa" }
              ]
            }
          ]
        }
      }
    },
    AUTH
  );
}

// פונקציית עזר לשליחת טקסט
async function sendText(to, body) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    AUTH
  );
}

// --- GET /webhook - verification ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- POST /webhook - handle messages ---
app.post("/webhook", async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from;

        // אם המשתמש לחץ על כפתור פתיחה
        if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
          const id = msg.interactive.button_reply.id;
          if (id === "role_cliente") {
            await sendClientList(from);
            continue;
          }
          if (id === "role_tecnico") {
            await sendText(from, "Función de *Técnico* en construcción...");
            continue;
          }
        }

        // אם זו הודעת טקסט ראשונה – שולחים תפריט פתיחה (Cliente/Técnico)
        if (msg.type === "text") {
          await sendButtons(
            from,
            "*Bienvenido a Servicio24*\n\n*Selecciona tu rol:*",
            [
              { id: "role_cliente", title: "Cliente" },
              { id: "role_tecnico", title: "Técnico" }
            ]
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
