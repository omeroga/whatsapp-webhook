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

// === session memory ===
// key: user number, value: { lastWelcome, pendingService, pendingZone }
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();

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
        header: { type: "text", text: "Bienvenido a Servicio24" },
        body: { text: "*Selecciona tu rol:*\n" },
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
        header: { type: "text", text: "Servicios disponibles" },
        body: { text: "\n*Elige el profesional que necesitas:*" },
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

// --------- Zona selection (grouped 1–10, 11–20, 21–25) ----------
async function sendZonaGroupButtons(to) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Selecciona tu zona" },
        body: { text: "Elige el rango de zona correspondiente:" },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "zona_group_1_10", title: "Zona 1–10" } },
            { type: "reply", reply: { id: "zona_group_11_20", title: "Zona 11–20" } },
            { type: "reply", reply: { id: "zona_group_21_25", title: "Zona 21–25" } },
          ],
        },
      },
    },
    AUTH
  );
}

// --------- Zona list (exact choice within a group) ----------
async function sendZonaList(to, start, end) {
  const rows = [];
  for (let i = start; i <= end; i++) {
    rows.push({ id: `zona_pick_${i}`, title: `Zona ${i}` });
  }
  const headerText = `Zonas ${start}–${end}`;

  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: headerText },
        body:   { text: "*Elige tu zona exacta:*" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir zona",
          sections: [
            { title: "Zonas disponibles", rows }
          ]
        }
      }
    },
    AUTH
  );
}

// --------- Zona confirm (Confirmar / Cambiar / Ver otros servicios) ----------
async function sendZonaConfirm(to, zoneNumber) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: `Zona seleccionada: ${zoneNumber}` },
        body:   { text: "¿Desea continuar con esta zona?" },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: `zona_confirm_${zoneNumber}`, title: "Confirmar" } },
            { type: "reply", reply: { id: "zona_change",                title: "Cambiar zona" } },
            { type: "reply", reply: { id: "zona_other_services",        title: "Ver otros servicios" } },
          ],
        },
      },
    },
    AUTH
  );
}

// --------- Service name map (shared) ----------
const SERVICE_NAME_MAP = {
  srv_plomero: "Plomero",
  srv_electricista: "Electricista",
  srv_cerrajero: "Cerrajero",
  srv_aire: "Aire acondicionado",
  srv_mecanico: "Mecánico",
  srv_grua: "Servicio de grúa",
  srv_mudanza: "Mudanza",
};

// --------- Profesiones ----------
async function handleProfession(to, id) {
  const name = SERVICE_NAME_MAP[id] || "Profesional";

  // שמירת שירות שנבחר
  const prev = sessions.get(to) || {};
  sessions.set(to, { ...prev, pendingService: id });

  await sendText(
    to,
    `*Perfecto*, seleccionaste: *${name}*.\n\nAhora selecciona tu zona para encontrar proveedores cercanos.`
  );

  await sendZonaGroupButtons(to);
}

// --- intent & source detection (organic vs paid) ---
const SERVICE_WORDS = {
  plomero: "srv_plomero",
  electricista: "srv_electricista",
  cerrajero: "srv_cerrajero",
  aire: "srv_aire",
  mecanico: "srv_mecanico",
  mecánico: "srv_mecanico",
  grua: "srv_grua",
  grúa: "srv_grua",
  mudanza: "srv_mudanza",
};

function parseOriginAndIntent(msg) {
  const out = { source: "organic", serviceId: null, zone: null };

  if (msg.referral) {
    out.source = "paid";
    const pre = msg.text?.body || "";
    extractFromText(pre, out);
    return out;
  }

  if (msg.type === "text") {
    const text = msg.text?.body || "";
    extractFromText(text, out);
  }

  return out;
}

function extractFromText(text, out) {
  const low = (text || "").toLowerCase();

  for (const key of Object.keys(SERVICE_WORDS)) {
    if (low.includes(`#${key}`)) {
      out.serviceId = SERVICE_WORDS[key];
      break;
    }
  }

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
          const prev = sessions.get(from) || {};

          if (intent.serviceId && intent.zone) {
            const zoneNum = parseInt(intent.zone.replace("z", ""), 10);
            sessions.set(from, { ...prev, pendingService: intent.serviceId, pendingZone: zoneNum });

            await sendText(from, `*Perfecto*, seleccionaste: *${SERVICE_NAME_MAP[intent.serviceId] || "Profesional"}*.`);
            await sendZonaConfirm(from, zoneNum);
            continue;
          }

          if (intent.serviceId && !intent.zone) {
            sessions.set(from, { ...prev, pendingService: intent.serviceId });
            await sendText(from, `*Perfecto*, seleccionaste: *${SERVICE_NAME_MAP[intent.serviceId] || "Profesional"}*.\n\nAhora selecciona tu zona para encontrar proveedores cercanos.`);
            await sendZonaGroupButtons(from);
            continue;
          }

          if (!intent.serviceId && intent.zone) {
            const zoneNum = parseInt(intent.zone.replace("z", ""), 10);
            sessions.set(from, { ...prev, pendingZone: zoneNum });
            await sendText(from, `Zona detectada: *${zoneNum}*.\n\nElige el servicio que necesitas:`);
            await sendClientList(from);
            continue;
          }

          // fallback paid
          sessions.set(from, { ...prev, lastWelcome: Date.now() });
          await sendClientList(from);
          continue;
        }

        // 1) Free text -> role menu (with throttle memory)
        if (msg.type === "text") {
          const now = Date.now();
          const session = sessions.get(from);

          if (!session || now - session.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { ...(session || {}), lastWelcome: now });
          }

          continue;
        }

        // 2) Button replies (role selection, zona groups, confirm)
        const interactive = msg.interactive;

        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          // role selection
          if (id === "role_cliente") {
            await sendClientList(from);
            const prev = sessions.get(from) || {};
            sessions.set(from, { ...prev, lastWelcome: Date.now() });
            continue;
          }

          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            const prev = sessions.get(from) || {};
            sessions.set(from, { ...prev, lastWelcome: Date.now() });
            continue;
          }

          // zona groups -> open list
          if (id === "zona_group_1_10") {
            await sendZonaList(from, 1, 10);
            continue;
          }
          if (id === "zona_group_11_20") {
            await sendZonaList(from, 11, 20);
            continue;
          }
          if (id === "zona_group_21_25") {
            await sendZonaList(from, 21, 25);
            continue;
          }

          // confirm or change or other services
          if (id === "zona_change") {
            await sendZonaGroupButtons(from);
            continue;
          }

          if (id === "zona_other_services") {
            await sendClientList(from);
            continue;
          }

          if (id.startsWith("zona_confirm_")) {
            const zoneNumber = parseInt(id.replace("zona_confirm_", ""), 10);
            const sess = sessions.get(from) || {};
            const serviceId = sess.pendingService;
            const serviceName = SERVICE_NAME_MAP[serviceId] || "Profesional";

            // כאן תגיע אינטגרציית שליחת הליד לספקים הרלוונטיים
            await sendText(
              from,
              `Listo. Te conectaremos con 1–3 proveedores de *${serviceName}* en *Zona ${zoneNumber}*.`
            );

            // reset pending selections
            sessions.set(from, { lastWelcome: Date.now() });
            continue;
          }
        }

        // 3) List reply (profession or zona exacta)
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          // profession selection
          if (id?.startsWith("srv_")) {
            await handleProfession(from, id);
            const prev = sessions.get(from) || {};
            sessions.set(from, { ...prev, lastWelcome: Date.now() });
            continue;
          }

          // zona exacta selection
          if (id?.startsWith("zona_pick_")) {
            const zoneNumber = parseInt(id.replace("zona_pick_", ""), 10);

            // save pending zone
            const prev = sessions.get(from) || {};
            sessions.set(from, { ...prev, pendingZone: zoneNumber });

            // show confirm/change/other-services buttons
            await sendZonaConfirm(from, zoneNumber);
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
