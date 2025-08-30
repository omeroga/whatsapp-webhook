 //index.js
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
        const from = msg.from; // מספר הוואטסאפ של הלקוח (יעד המענה)
        // בשלב זה: מענה טקסט פשוט – נשדרג בהמשך לתפריטים
        await axios.post(
          GRAPH_URL,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { 
  body: "*Bienvenido, has llegado a Servicio24*\n\n*Elige tu rol para continuar:*\n\n1. *Cliente*\n2. *Técnico*"},
          },
          AUTH
        );
      }
    }

    // צריך להחזיר 200 כדי שמטה לא תנסה שוב
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    // תמיד 200 כדי לא לגרום לריטריים אינסופיים; לוגים מספיקים לנו לדיבאג
    return res.sendStatus(200);
  }
});

// --- server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
