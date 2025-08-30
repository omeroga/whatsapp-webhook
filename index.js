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
        const from = msg.from; // מספר הוואטסאפ של השולח

        // שולחים הודעת פתיחה עם כפתורים
        await axios.post(
          GRAPH_URL,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "interactive",
            interactive: {
              type: "button",
              body: {
                text: "*Bienvenido a Servicio24*\n\n*Selecciona tu rol:*",
              },
              action: {
                buttons: [
                  {
                    type: "reply",
                    reply: {
                      id: "role_cliente",
                      title: "Cliente",
                    },
                  },
                  {
                    type: "reply",
                    reply: {
                      id: "role_tecnico",
                      title: "Técnico",
                    },
                  },
                ],
              },
            },
          },
          AUTH
        );
      }
    }

    // תמיד להחזיר 200 כדי שמטה לא תנסה שוב
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// --- server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
