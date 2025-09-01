// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// Servicios:
// 🚰  Plomero
// ⚡  Electricista
// 🔑  Cerrajero
// ❄️  Aire acondicionado
// 🛠️  Mecánico
// 🛻  Servicio de grúa
// 🚚  Mudanza
// Zonas (Ciudad de Guatemala):
//  1 🏛️   2 🍺   3 🕊️   4 💰   5 🏟️
/* 6 🏘️   7 🏺   8 🚌   9 🏨  10 🎉
  11 🛒  12 🧰  13 ✈️  14 🏢  15 🎓
  16 🏰  17 🏭  18 🛣️  19 🔧  20 🏚️
  21 🚧  22 📦  23 🚋  24 🏗️  25 🌳 */

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

// === session memory (avoid spammy repeats) ===
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map(); // key: wa_number, val: { lastWelcome: ts }

// --------- Senders ----------
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

// --- City (organic flow) ---
async function sendCityList(to) {
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
          button: "Elegir", // CTA אחיד
          sections: [
            {
              title: "Ciudades",
              rows: [{ id: "city_guatemala", title: "Ciudad de Guatemala" }],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// --- City confirmation (paid flow) ---
async function sendCityConfirmPaid(to, cityName = "Ciudad de Guatemala") {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Ciudad detectada" },
        body: {
          text: `Detectamos *${cityName}* por tu anuncio. ¿Confirmas o deseas cambiar de ciudad?`,
        },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "paid_city_confirm", title: "Confirmar ciudad" } },
            { type: "reply", reply: { id: "paid_city_change", title: "Cambiar ciudad" } },
          ],
        },
      },
    },
    AUTH
  );
}

// --- Client services list ---
async function sendClientList(to, cityName = "Ciudad de Guatemala") {
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Servicios disponibles" },
        body: { text: "Elige el profesional que necesitas:" },
        footer: { text: `Servicio24 • ${cityName}` },
        action: {
          button: "Elegir", // CTA אחיד
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

// --- Zonas (single list with 3 sections) ---
async function sendZonaList(to, cityId = "GUA") {
  // cityId שמור לעתיד כשנוסיף עוד ערים, כרגע לא מתבצע סינון לפי עיר
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Selecciona tu zona" },
        body: { text: "Elige tu zona exacta:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir", // CTA אחיד
          sections: [
            {
              title: "Zonas 1–10",
              rows: [
                { id: "z1",  title: "Zona 1 🏛️" },
                { id: "z2",  title: "Zona 2 🍺" },
                { id: "z3",  title: "Zona 3 🕊️" },
                { id: "z4",  title: "Zona 4 💰" },
                { id: "z5",  title: "Zona 5 🏟️" },
                { id: "z6",  title: "Zona 6 🏘️" },
                { id: "z7",  title: "Zona 7 🏺" },
                { id: "z8",  title: "Zona 8 🚌" },
                { id: "z9",  title: "Zona 9 🏨" },
                { id: "z10", title: "Zona 10 🎉" },
              ],
            },
            {
              title: "Zonas 11–20",
              rows: [
                { id: "z11", title: "Zona 11 🛒" },
                { id: "z12", title: "Zona 12 🧰" },
                { id: "z13", title: "Zona 13 ✈️" },
                { id: "z14", title: "Zona 14 🏢" },
                { id: "z15", title: "Zona 15 🎓" },
                { id: "z16", title: "Zona 16 🏰" },
                { id: "z17", title: "Zona 17 🏭" },
                { id: "z18", title: "Zona 18 🛣️" },
                { id: "z19", title: "Zona 19 🔧" },
                { id: "z20", title: "Zona 20 🏚️" },
              ],
            },
            {
              title: "Zonas 21–25",
              rows: [
                { id: "z21", title: "Zona 21 🚧" },
                { id: "z22", title: "Zona 22 📦" },
                { id: "z23", title: "Zona 23 🚋" },
                { id: "z24", title: "Zona 24 🏗️" },
                { id: "z25", title: "Zona 25 🌳" },
              ],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// --- Confirm zone + consent in one step ---
async function sendZoneConfirm(to, zonaId) {
  const label = `Zona ${zonaId.replace("z", "")}`;
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Confirmación" },
        body: {
          text: `¿Confirmas *${label}* y aceptas recibir llamadas o mensajes de 1–3 proveedores cercanos? (Sin costo)`,
        },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: `zone_confirm_${zonaId}`, title: "Sí, continuar" } },
            { type: "reply", reply: { id: "zone_change", title: "Cambiar zona" } },
          ],
        },
      },
    },
    AUTH
  );
}

// --- After profession selection -> move to zonas (with small delay + fallback) ---
async function handleProfession(to, id, cityId) {
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

  await sendText(
    to,
    `*Perfecto*, seleccionaste: *${name}*.\n\nAhora selecciona tu zona para encontrar proveedores cercanos.`
  );

  await new Promise((res) => setTimeout(res, 350));

  try {
    await sendZonaList(to, cityId || "GUA");
  } catch (e) {
    console.error("sendZonaList failed:", e?.response?.data || e.message);
    await sendText(
      to,
      "No pude abrir el menú de *Zonas*. Escribe tu zona (1–25) o responde con *menu* para reintentar."
    );
  }
}

// --- intent & source detection ---
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
  const out = { source: "organic", serviceId: null, cityId: "GUA", zone: null };

  // paid via referral or prefilled text → מסמנים כממומן
  if (msg.referral) {
    out.source = "paid";
  }

  if (msg.type === "text") {
    const low = (msg.text?.body || "").toLowerCase();
    for (const k of Object.keys(SERVICE_WORDS)) {
      if (low.includes(`#${k}`)) out.serviceId = SERVICE_WORDS[k];
    }
    const zMatch = low.match(/\b(?:zona\s*)?z?(\d{1,2})\b/);
    if (zMatch) {
      const n = parseInt(zMatch[1], 10);
      if (n >= 1 && n <= 25) out.zone = `z${n}`;
    }
    if (out.serviceId || out.zone) out.source = "paid";
  }

  return out;
}

// --------- Webhook ----------
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

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const messages = value?.messages;

    if (Array.isArray(messages) && messages.length) {
      for (const msg of messages) {
        const from = msg.from;
        const interactive = msg.interactive;
        const intent = parseOriginAndIntent(msg);

        // --- Paid entry: confirm city first ---
        if (intent.source === "paid" && msg.type === "text") {
          await sendCityConfirmPaid(from, "Ciudad de Guatemala");
          sessions.set(from, { lastWelcome: Date.now() });
          continue;
        }

        // --- Organic free text: show role menu (rate-limited) ---
        if (msg.type === "text") {
          const now = Date.now();
          const session = sessions.get(from);
          if (!session || now - session.lastWelcome > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { lastWelcome: now });
          }
          continue;
        }

        // --- Button replies ---
        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          // roles
          if (id === "role_cliente") {
            await sendCityList(from);
            sessions.set(from, { lastWelcome: Date.now() });
            continue;
          }
          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            sessions.set(from, { lastWelcome: Date.now() });
            continue;
          }

          // paid city confirm/change
          if (id === "paid_city_confirm") {
            // אם בא ממומן + יש שירות מזוהה בטקסט → ישר למקצוע
            if (intent.serviceId) {
              await handleProfession(from, intent.serviceId, "GUA");
            } else {
              await sendClientList(from, "Ciudad de Guatemala");
            }
            continue;
          }
          if (id === "paid_city_change") {
            await sendCityList(from);
            continue;
          }

          // zone confirmation step
          if (id.startsWith("zone_confirm_z")) {
            const zona = id.replace("zone_confirm_", ""); // e.g. z7
            // כאן בעתיד: שליחת ליד לספקים לפי service + zona
            await sendText(
              from,
              `¡Listo! Guardamos *${zona.toUpperCase()}*. En breve te contactarán 1–3 proveedores cercanos.`
            );
            continue;
          }
          if (id === "zone_change") {
            await sendZonaList(from, "GUA");
            continue;
          }
        }

        // --- List replies (city / service / zona) ---
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          // city
          if (id?.startsWith("city_")) {
            await sendClientList(from, "Ciudad de Guatemala");
            continue;
          }

          // service
          if (id?.startsWith("srv_")) {
            await handleProfession(from, id, "GUA");
            continue;
          }

          // zona exacta selected → ask combined confirm/consent
          if (id?.startsWith("z")) {
            await sendZoneConfirm(from, id);
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
