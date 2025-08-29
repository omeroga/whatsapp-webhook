// index.js
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- GET /webhook - verification (Meta console) ---
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // אותו טוקן שהגדרת ב-Meta

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

    if (messages && messages.length) {
      for (const msg of messages) {
        const from = msg.from; // מספר הווטסאפ של הלקוח
        const type = msg.type; // סוג ההודעה

        // עונים רק כשזו הודעת טקסט נכנסת
        if (type === "text") {
          const menu =
            "שלום, הגעתם לשירות מוניות עומר 🚖\n" +
            "בחרו אחת מהאפשרויות:\n" +
            "1. להזמין מונית\n" +
            "2. לדבר עם נציג";

          await axios.post(
            `https://graph.facebook.com/v23.0/${process.env.PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: "whatsapp",
              to: from,
              text: { body: menu },
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
              },
            }
          );
        }
      }
    }

    // חייבים להחזיר 200 כדי שמטה לא תנסה שוב
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(500);
  }
});

// --- server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
