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

// --- POST /webhook - receive messages & reply ---
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from; // מי שלח
        const type = msg.type; // סוג הודעה נכנסת

        // 1) אם זו הודעת טקסט "חופשית" -> שלח תפריט כפתורים
        if (type === "text") {
          await axios.post(
            GRAPH_URL,
            {
              messaging_product: "whatsapp",
              to: from,
              type: "interactive",
              interactive: {
                type: "button",
                body: {
                  text:
                    "*Bienvenido, has llegado a Servicio24*\n\n" +
                    "*Elige tu rol para continuar:*\n"
                },
                action: {
                  buttons: [
                    {
                      type: "reply",
                      reply: { id: "role_client", title: "Cliente" }
                    },
                    {
                      type: "reply",
                      reply: { id: "role_tech", title: "Técnico" }
                    }
                  ]
                }
              }
            },
            AUTH
          );
          continue;
        }

        // 2) אם זו תשובה לכפתור (יש שני פורמטים אפשריים)
        // א. type === "button" (פורמט ישן יותר)
        if (type === "button") {
          const payload = msg.button?.payload || msg.button?.text;
          await handleRoleSelection(from, payload);
          continue;
        }

        // ב. type === "interactive" עם button_reply/list_reply (פורמט חדש)
        if (type === "interactive") {
          const i = msg.interactive;
          let payload = null;
          if (i?.type === "button_reply") payload = i.button_reply?.id || i.button_reply?.title;
          if (i?.type === "list_reply") payload = i.list_reply?.id || i.list_reply?.title;
          if (payload) {
            await handleRoleSelection(from, payload);
            continue;
          }
        }

        // סוגים אחרים — מתעלמים כרגע
      }
    }

    return res.sendStatus(200); // חשוב להשיב 200 כדי למנוע ריטריי
  } catch (err) {
    console.error("Webhook POST error:", err?.response?.data || err.message);
    return res.sendStatus(200); // משיבים 200 גם בשגיאה (לוגים מספיקים לנו)
  }
});

// --- קטנה: פונקציה שמטפלת בבחירת תפקיד ---
async function handleRoleSelection(to, payload) {
  const pickedClient = /role_client/i.test(payload);
  const pickedTech = /role_tech/i.test(payload);

  let body;
  if (pickedClient) {
    body = "Perfecto. Has elegido *Cliente*. ¿En qué podemos ayudarte?";
  } else if (pickedTech) {
    body = "Perfecto. Has elegido *Técnico*. Vamos a registrarte.";
  } else {
    body = "No he entendido tu selección. Por favor elige *Cliente* o *Técnico*.";
  }

  await axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    AUTH
  );
}

// --- server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
