// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ENV: GRAPH_VERSION (e.g. v23.0), PHONE_NUMBER_ID, WHATSAPP_TOKEN, VERIFY_TOKEN
const GRAPH_URL = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// simple in-memory session per phone
const sessions = new Map();

async function sendWelcomeButtons(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Bienvenido a Servicio24\n\nSelecciona tu rol" },
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

async function sendText(to, body) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    AUTH
  );
}

// GET /webhook for verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /webhook for messages
app.post("/webhook", async (req, res) => {
  try {
    const changes = req.body?.entry?.[0]?.changes;
    const messages = changes?.[0]?.value?.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from;
        const sess = sessions.get(from) || { menuShown: false, role: null };

        // button reply
        if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
          const id = msg.interactive.button_reply.id;
          if (id === "role_cliente") {
            sess.role = "cliente";
            sessions.set(from, sess);
            await sendText(from, "Perfecto ✅\nHas elegido *Cliente*.");
            continue;
          }
          if (id === "role_tecnico") {
            sess.role = "tecnico";
            sessions.set(from, sess);
            await sendText(from, "Perfecto ✅\nHas elegido *Técnico*.");
            continue;
          }
        }

        // first text from user or explicit ask for menu
        if (msg.type === "text") {
          const body = (msg.text?.body || "").trim().toLowerCase();
          const wantsMenu = ["menu", "menú", "inicio", "start"].includes(body);
          if (!sess.menuShown || wantsMenu) {
            await sendWelcomeButtons(from);
            sess.menuShown = true;
            sessions.set(from, sess);
            continue;
          }
        }

        // ignore other message types for now
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
