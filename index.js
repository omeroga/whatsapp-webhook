// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// Servicios:
// 🚰 Plomero | ⚡ Electricista | 🔑 Cerrajero | ❄️ Aire acondicionado
// 🛠️ Mecánico | 🛻 Servicio de grúa | 🚚 Mudanza
// Zonas (1–25) — EMOJI por zona (resumen):
// 1 🏛️, 2 🍺, 3 🕊️, 4 💰, 5 🏟️, 6 🏘️, 7 🌳, 8 🚌, 9 🏨, 10 🎉,
// 11 🛒, 12 🧰, 13 ✈️, 14 🏢, 15 🎓, 16 🏰, 17 🏭, 18 🛣️, 19 🔧,
// 20 🏚️, 21 🚧, 22 📦, 23 🚋, 24 🏗️, 25 🌳

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ---------- Consts / Helpers ----------
const GRAPH_URL = `https://graph.facebook.com/v${process.env.GRAPH_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
const AUTH = {
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  },
};

// Zonas emojis (1..25)
const ZONA_EMOJI = {
  1: "🏛️",  2: "🍺",  3: "🕊️",  4: "💰",  5: "🏟️",
  6: "🏘️",  7: "🌳",  8: "🚌",  9: "🏨", 10: "🎉",
 11: "🛒", 12: "🧰", 13: "✈️", 14: "🏢", 15: "🎓",
 16: "🏰", 17: "🏭", 18: "🛣️", 19: "🔧", 20: "🏚️",
 21: "🚧", 22: "📦", 23: "🚋", 24: "🏗️", 25: "🌳",
};

// === session memory (debounce) ===
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map(); // key: user, value: { lastWelcome }

// ---------- Senders ----------
async function sendText(to, text) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
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

async function sendCityList(to) {
  // (כרגע עיר אחת, ניתן להרחיב)
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Selecciona tu ciudad" },
        body: { text: "Elige una ciudad para continuar:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir ciudad",
          sections: [
            {
              title: "Ciudades",
              rows: [
                { id: "city_gtm", title: "Ciudad de Guatemala" },
              ],
            },
          ],
        },
      },
    },
    AUTH
  );
}

async function sendClientList(to, cityLabel) {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" },
        body: {
          text:
            "*Elige el profesional que necesitas:*\n" +
            (cityLabel ? `Servicio24 • ${cityLabel}` : "Servicio24"),
        },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir profesional",
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

// === ZONAS ===

// (A) כפתורי קבוצות — הכל בהודעה אחת (בלי טקסט נפרד)
async function sendZonaGroupButtonsIntro(to, serviceName) {
  const body =
    `*Perfecto*, seleccionaste: *${serviceName}*.\n\n` +
    "Ahora selecciona tu zona para encontrar proveedores cercanos.";
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Zonas 1–25" },
        body: { text: body },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "zona_group_1_10",  title: "Zona 1–10" } },
            { type: "reply", reply: { id: "zona_group_11_20", title: "Zona 11–20" } },
            { type: "reply", reply: { id: "zona_group_21_25", title: "Zona 21–25" } },
          ],
        },
      },
    },
    AUTH
  );
}

// (B) ליסט של זונות ספציפיות (10/10/5) עם אימוג'י בכל שורה
function zonaRows(from, to) {
  const rows = [];
  for (let n = from; n <= to; n++) {
    rows.push({
      id: `zona_pick_${n}`,
      title: `${ZONA_EMOJI[n]}  Zona ${n}`,
    });
  }
  return rows;
}

async function sendZonaList(to, groupId) {
  let title = "", rows = [];
  if (groupId === "zona_group_1_10") {
    title = "Zonas 1–10";
    rows = zonaRows(1, 10);
  } else if (groupId === "zona_group_11_20") {
    title = "Zonas 11–20";
    rows = zonaRows(11, 20);
  } else {
    title = "Zonas 21–25";
    rows = zonaRows(21, 25);
  }

  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title },
        body: { text: "Elige tu zona exacta:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir zona",
          sections: [{ title, rows }],
        },
      },
    },
    AUTH
  );
}

// (C) מסך אישור זונה (אורגני: שני כפתורים)
async function sendZonaConfirm(to, n) {
  const em = ZONA_EMOJI[n] || "";
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: `Zona seleccionada: ${n} ${em}` },
        body: { text: "¿Desea continuar con esta zona?" },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: `zona_confirm_${n}`, title: "Confirmar" } },
            { type: "reply", reply: { id: "zona_change", title: "Cambiar zona" } },
          ],
        },
      },
    },
    AUTH
  );
}

// --------- Profesiones ----------
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
  // שולחים *באותה* הודעה את ההנחיה + הכפתורים לקבוצות הזונה
  return sendZonaGroupButtonsIntro(to, name);
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
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;

        // 1) Free text -> role menu (throttle)
        if (msg.type === "text") {
          const now = Date.now();
          const s = sessions.get(from);
          if (!s || now - s.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { lastWelcome: now });
          }
          continue;
        }

        const interactive = msg.interactive;

        // 2) Button replies
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          if (id === "role_cliente") { await sendCityList(from); continue; }
          if (id === "role_tecnico") { await sendText(from, "La función de *Técnico* está en construcción…"); continue; }

          // ZONA groups → open list (single message)
          if (id === "zona_group_1_10" || id === "zona_group_11_20" || id === "zona_group_21_25") {
            await sendZonaList(from, id);
            continue;
          }

          // ZONA confirm
          if (id?.startsWith("zona_confirm_")) {
            const n = parseInt(id.split("_").pop(), 10);
            await sendText(from, `Listo ✅ Zona ${n} ${ZONA_EMOJI[n] || ""}. En breve te contactarán 1–3 proveedores cercanos.`);
            continue;
          }

          if (id === "zona_change") {
            await sendZonaGroupButtonsIntro(from, ""); // sin nombre servicio
            continue;
          }
        }

        // 3) List replies (city / service / zona exacta)
        if (interactive?.type === "list_reply") {
          const lr = interactive.list_reply;
          const id = lr?.id;

          // City
          if (id === "city_gtm") {
            await sendClientList(from, "Ciudad de Guatemala");
            continue;
          }

          // Service
          if (id?.startsWith("srv_")) {
            await handleProfession(from, id);
            continue;
          }

          // Zona exacta (zona_pick_N)
          if (id?.startsWith("zona_pick_")) {
            const n = parseInt(id.split("_").pop(), 10);
            await sendZonaConfirm(from, n);
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
