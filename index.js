// index.js
const express = require("express");
const app = express();

app.use(express.json());

// ====== CONFIG ======
const VERIFY_TOKEN = "subitetest";                          // חייב להתאים למה שהגדרת במטא
const WABA_TOKEN    = process.env.WHATSAPP_TOKEN;           // להגדיר ב-Render
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;        // להגדיר ב-Render

// ====== HELPERS ======
async function sendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WABA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Send message error:", res.status, err);
  }
}

// ====== WEBHOOK VERIFY (GET) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ====== WEBHOOK RECEIVE (POST) ======
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const messages = change?.value?.messages;

    if (messages && messages.length) {
      for (const msg of messages) {
        const from = msg.from;                 // מספר הוואטסאפ של הלקוח (בפורמט בינ"ל ללא +)
        const type = msg.type;

        // שולחים תפריט פתיחה על כל הודעת טקסט שנכנסת
        if (type === "text" || type === "button" || type === "interactive") {
          const menu =
`שלום! הגעתם ל-Subite 🚖
בחרו אפשרות:
1) להזמין מונית
2) לבדוק מחיר נסיעה
3) עזרה/נציג

כתבו מספר (1-3) כדי להמשיך.`;
          await sendText(from, menu);
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.sendStatus(200); // תמיד 200 למטא
  }
});

// ====== HEALTH ======
app.get("/", (_, res) => res.status(200).send("OK"));

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

