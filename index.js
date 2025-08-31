// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// 🚰  Plomero
// ⚡  Electricista
// 🔑  Cerrajero
// ❄️  Aire acondicionado
// 🛠️  Mecánico
// 🛻  Servicio de grúa
// 🚚  Mudanza

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

// === session memory to avoid re-sending the welcome ===
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const sessions = new Map(); // key: user number, value: { lastWelcome: timestamp }

// --------- Senders ----------
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

async function sendRoleButtons(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Bienvenido a Servicio24" }, // no Markdown in header
        body: { text: "*Selecciona tu rol:*\n" }, // bold + visual separation
        footer: { text: "Servicio24" },
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

async function sendClientList(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" }, // no Markdown in header
        body: { text: "\n*Elige el profesional que necesitas:*" }, // leading newline + bold
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

// --- intent & source detection (organic vs paid) ---
const SERVICE_WORDS = {
  plomero: "srv_plomero",
  electricista: "srv_electricista",
  cerrajero: "srv_cerrajero",
  aire: "srv_aire",          // "aire acondicionado"
  mecanico: "srv_mecanico",
  mecánico: "srv_mecanico",  // con tilde
  grua: "srv_grua",
  grúa: "srv_grua",
  mudanza: "srv_mudanza",
};

function parseOriginAndIntent(msg) {
  const out = { source: "organic", serviceId: null, zone: null };

  // paid via referral or prefilled text
  if (msg.referral) {
    out.source = "paid";
    const pre = msg.text?.body || "";
    extractFromText(pre, out);
    return out;
  }

  // organic text that may include hashtags like #plomero z7
  if (msg.type === "text") {
    const text = msg.text?.body || "";
    extractFromText(text, out);
  }

  return out;
}

function extractFromText(text, out) {
  const low = (text || "").toLowerCase();

  // service
  for (const key of Object.keys(SERVICE_WORDS)) {
    if (low.includes(`#${key}`)) {
      out.serviceId = SERVICE_WORDS[key];
      break;
    }
  }

  // zona 1-25 (z7, zona 7, etc.)
  const zMatch = low.match(/\b(?:zona\s*)?z?(\d{1,2})\b/);
  if (zMatch) {
    const n = parseInt(zMatch[1], 10);
    if (n >= 1 && n <= 25) out.zone = `z${n}`;
  }

  if (out.serviceId || out.zone) {
    out.source = "paid";
  }
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

        // detect origin (organic vs paid)
        const intent = parseOriginAndIntent(msg);

        if (intent.source === "paid") {
          if (intent.serviceId) {
            await handleProfession(from, intent.serviceId);
          } else {
            await sendClientList(from);
          }
          sessions.set(from, { lastWelcome: Date.now() });
          continue;
        }

        // 1) Free text -> role menu (with throttle memory)
        if (msg.type === "text") {
          const now = Date.now();
          const session = sessions.get(from);

          if (!session || now - session.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { lastWelcome: now });
          }

          continue;
        }

        // 2) Button replies (role selection)
        const interactive = msg.interactive;

        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          if (id === "role_cliente") {
            await sendClientList(from);
            sessions.set(from, { lastWelcome: Date.now() });
            continue;
          }

          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            sessions.set(from, { lastWelcome: Date.now() });
            continue;
          }
        }

        // 3) List reply (profession selection)
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          if (id?.startsWith("srv_")) {
            await handleProfession(from, id);
            sessions.set(from, { lastWelcome: Date.now() });
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
