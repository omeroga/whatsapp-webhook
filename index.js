// index.js
// === Servicio24: emojis oficiales (NO CAMBIAR sin instrucción) ===
// Servicios:
// 🚰  Plomero | ⚡  Electricista | 🔑  Cerrajero | ❄️  Aire acondicionado
// 🛠️  Mecánico | 🛻  Servicio de grúa | 🚚  Mudanza
// Zonas (1–25):
// 1 🏛️ | 2 🍺 | 3 🕊️ | 4 💰 | 5 🏟️ | 6 🏘️ | 7 🌳 | 8 🚌 | 9 🏨 | 10 🎉
// 11 🛒 | 12 🧰 | 13 ✈️ | 14 🏢 | 15 🎓 | 16 🏰 | 17 🏭 | 18 🛣️ | 19 🔧 | 20 🏚️
// 21 🚧 | 22 📦 | 23 🚋 | 24 🏗️ | 25 🌳

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
const sessions = new Map(); // key: user, value: { lastWelcome, cityId }

// ---- Zonas emojis map ----
const ZONE_EMOJI = {
  z1: "🏛️",  z2: "🍺",  z3: "🕊️",  z4: "💰",  z5: "🏟️",
  z6: "🏘️",  z7: "🌳",  z8: "🚌",  z9: "🏨",  z10: "🎉",
  z11: "🛒", z12: "🧰", z13: "✈️", z14: "🏢", z15: "🎓",
  z16: "🏰", z17: "🏭", z18: "🛣️", z19: "🔧", z20: "🏚️",
  z21: "🚧", z22: "📦", z23: "🚋", z24: "🏗️", z25: "🌳",
};

// --------- Senders ----------
async function sendText(to, text) {
  return axios.post(
    GRAPH_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    AUTH
  );
}

// botón de roles
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

// lista de ciudades (por ahora solo Ciudad de Guatemala)
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
          button: "Elegir ciudad",
          sections: [
            {
              title: "Ciudades",
              rows: [{ id: "city_gua", title: "Ciudad de Guatemala" }],
            },
          ],
        },
      },
    },
    AUTH
  );
}

// lista de servicios (muestra ciudad en el subtítulo si יש)
async function sendClientList(to, cityName = null) {
  const subtitle = cityName ? `Servicio24 · ${cityName}` : "Servicio24";
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
        footer: { text: subtitle },
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

// ---- Zonas: lista מלאה 1–25 בשלוש קבוצות ----
function makeZonaRows(from, to) {
  const rows = [];
  for (let n = from; n <= to; n++) {
    const id = `zona_${n}`;
    const key = `z${n}`;
    const emoji = ZONE_EMOJI[key] || "";
    rows.push({ id, title: `Zona ${n}  ${emoji}`.trim() });
  }
  return rows;
}

async function sendZonaList(to, cityId = "GUA") {
  // ניתן להרחיב cityId בעתיד; כרגע לא משפיע על ה-UI
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "Zonas" },
        body: { text: "Elige tu zona exacta:" },
        footer: { text: "Servicio24" },
        action: {
          button: "Elegir zona",
          sections: [
            { title: "Zonas 1–10", rows: makeZonaRows(1, 10) },
            { title: "Zonas 11–20", rows: makeZonaRows(11, 20) },
            { title: "Zonas 21–25", rows: makeZonaRows(21, 25) },
          ],
        },
      },
    },
    AUTH
  );
}

// אישור/שינוי זונה
async function sendZoneConfirm(to, zoneId) {
  const n = parseInt(zoneId.replace("z", ""), 10);
  const emoji = ZONE_EMOJI[zoneId] || "";
  return axios.post(
    GRAPH_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: `Zona seleccionada: ${n}` },
        body: { text: "¿Desea continuar con esta zona?" },
        footer: { text: "Servicio24" },
        action: {
          buttons: [
            { type: "reply", reply: { id: `confirm_zone_${zoneId}`, title: "Confirmar" } },
            { type: "reply", reply: { id: "change_zone", title: "Cambiar zona" } },
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

  // הודעת אישור מקצוע
  await sendText(
    to,
    `*Perfecto*, seleccionaste: *${name}*.\n\nAhora selecciona tu zona para encontrar proveedores cercanos.`
  );

  // השהייה + ריטריי לפתיחת ה-List בוודאות
  await new Promise((r) => setTimeout(r, 1000));
  try {
    await sendZonaList(to, "GUA");
  } catch (e1) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await sendZonaList(to, "GUA");
    } catch (e2) {
      console.error("sendZonaList failed twice:", e2?.response?.data || e2.message);
      await sendText(
        to,
        "No pude abrir el menú de *Zonas*. Escribe tu zona (1–25) o responde con *menu* para reintentar."
      );
    }
  }
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
  const out = { isReferral: !!msg.referral, source: "organic", serviceId: null, zone: null };

  if (msg.type === "text" && msg.text?.body) {
    const low = msg.text.body.toLowerCase();
    // service hashtag
    for (const key of Object.keys(SERVICE_WORDS)) {
      if (low.includes(`#${key}`)) out.serviceId = SERVICE_WORDS[key];
    }
    // zona (z7 / zona 7)
    const m = low.match(/\b(?:zona\s*)?z?(\d{1,2})\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 25) out.zone = `z${n}`;
    }
  }

  if (out.isReferral || out.serviceId || out.zone) out.source = "paid";
  return out;
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

        // detect origin / intent
        const intent = parseOriginAndIntent(msg);

        // ===== Paid flow (referral) =====
        if (intent.isReferral) {
          if (intent.zone) {
            await sendZoneConfirm(from, intent.zone);
          } else {
            await sendZonaList(from, "GUA");
          }
          continue;
        }

        // ===== ORGÁNICO =====
        if (msg.type === "text") {
          const low = (msg.text?.body || "").toLowerCase().trim();

          // קיצור דרך: "menu" לפתיחת zonas מחדש
          if (low === "menu") {
            await sendZonaList(from, "GUA");
            continue;
          }

          // קיצור דרך: מספר 1–25 → אישור/שינוי
          const num = low.match(/^(?:zona\s*)?(\d{1,2})$/i);
          if (num) {
            const n = parseInt(num[1], 10);
            if (n >= 1 && n <= 25) {
              await sendZoneConfirm(from, `z${n}`);
              continue;
            }
          }

          // throttle הודעת פתיחה
          const now = Date.now();
          const session = sessions.get(from);
          if (!session || now - (session.lastWelcome || 0) > SESSION_TTL_MS) {
            await sendRoleButtons(from);
            sessions.set(from, { ...(session || {}), lastWelcome: now });
          }
          continue;
        }

        // אינטראקטיב: כפתורים
        const interactive = msg.interactive;

        if (interactive?.type === "button_reply") {
          const id = interactive.button_reply?.id;

          if (id === "role_cliente") {
            await sendCityList(from);
            sessions.set(from, { ...(sessions.get(from) || {}), lastWelcome: Date.now() });
            continue;
          }

          if (id === "role_tecnico") {
            await sendText(from, "La función de *Técnico* está en construcción…");
            sessions.set(from, { ...(sessions.get(from) || {}), lastWelcome: Date.now() });
            continue;
          }

          if (id === "change_zone") {
            await sendZonaList(from, "GUA");
            continue;
          }

          // confirm_zone_z7 → חלץ z7
          if (id?.startsWith("confirm_zone_")) {
            const zoneId = id.replace("confirm_zone_", ""); // למשל z7
            const emoji = ZONE_EMOJI[zoneId] || "";
            await sendText(
              from,
              `Zona confirmada: *${zoneId.replace("z", "")}* ${emoji}\nEn breve te contactarán 1–3 proveedores cercanos.`
            );
            continue;
          }
        }

        // אינטראקטיב: רשימות (city / service / zona)
        if (interactive?.type === "list_reply") {
          const id = interactive.list_reply?.id;

          if (id === "city_gua") {
            // שמירת עיר והמשך לרשימת שירותים
            const s = sessions.get(from) || {};
            sessions.set(from, { ...s, cityId: "GUA" });
            await sendClientList(from, "Ciudad de Guatemala");
            continue;
          }

          if (id?.startsWith("srv_")) {
            await handleProfession(from, id);
            sessions.set(from, { ...(sessions.get(from) || {}), lastWelcome: Date.now() });
            continue;
          }

          if (id?.startsWith("zona_")) {
            const n = parseInt(id.split("_")[1], 10);
            await sendZoneConfirm(from, `z${n}`);
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
