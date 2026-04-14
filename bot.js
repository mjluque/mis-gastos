/**
 * Bot de Telegram para registro de gastos — multi-usuario
 * ─────────────────────────────────────────────────────────
 * Instalación:
 *   npm install node-fetch express
 *
 * Variables de entorno:
 *   BOT_TOKEN    → Token de @BotFather
 *   WEBHOOK_URL  → URL pública del servidor (ej: https://mi-app.railway.app)
 *   ALLOWED_IDS  → IDs de Telegram autorizados, separados por coma (opcional)
 *   API_SECRET   → Clave para que la app web acceda a los datos (elegí una al azar)
 *
 * Formato de mensaje:
 *   gasto 2800 supermercado
 *   gasto 15000 alquiler vivienda fijo
 *   /resumen  /lista  /ayuda
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const BOT_TOKEN   = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_SECRET  = process.env.API_SECRET || "cambiar-esto";
const ALLOWED_IDS = process.env.ALLOWED_IDS
  ? process.env.ALLOWED_IDS.split(",").map((id) => id.trim())
  : [];

const DB_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

// ── Persistencia por usuario ──────────────────────────────────────────────────

function userFile(userId) {
  // Nombre de archivo seguro: solo dígitos del ID
  const safeId = String(userId).replace(/[^0-9]/g, "");
  return path.join(DB_DIR, `user_${safeId}.json`);
}

function loadUser(userId) {
  const file = userFile(userId);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveUser(userId, data) {
  fs.writeFileSync(userFile(userId), JSON.stringify(data, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth()).padStart(2, "0");
  return `${y}-${m}`;
}

function fmt(n) {
  return "$" + Number(n).toLocaleString("es-AR");
}

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

const CATEGORIES = [
  "Alimentación","Transporte","Vivienda","Salud","Entretenimiento",
  "Ropa","Educación","Servicios","Restaurantes","Otros",
];

function guessCategory(text) {
  const t = text.toLowerCase();
  if (/super|mercado|carrefour|coto|jumbo|dia|verdura|panadería/.test(t)) return "Alimentación";
  if (/sube|colectivo|tren|taxi|uber|remis|nafta|combustible/.test(t))    return "Transporte";
  if (/alquiler|expensas|luz|edesur|gas|metrogas|agua|internet|cable/.test(t)) return "Vivienda";
  if (/farmacia|médico|medico|obra social|dentista|hospital/.test(t))     return "Salud";
  if (/netflix|spotify|cine|teatro|disney|stream/.test(t))                return "Entretenimiento";
  if (/ropa|zapatillas|calzado|indumentaria/.test(t))                     return "Ropa";
  if (/curso|libro|universidad|colegio|escuela/.test(t))                  return "Educación";
  if (/resto|restaurant|bar|café|cafe|pizza|sushi/.test(t))               return "Restaurantes";
  return null;
}

// ── Parser de mensajes ────────────────────────────────────────────────────────

function parseExpense(text) {
  const TYPES = ["fijo", "variable", "extraordinario"];
  const parts = text.trim().toLowerCase().replace(/^gasto\s+/, "").split(/\s+/);

  const amount = parseFloat(parts[0].replace(",", ".").replace(/[^0-9.]/g, ""));
  if (!amount || isNaN(amount)) return null;

  let typeFound = "Variable";
  let catFound  = null;
  const descParts = [];

  for (let i = 1; i < parts.length; i++) {
    const w    = parts[i];
    const wCap = w.charAt(0).toUpperCase() + w.slice(1);
    if (TYPES.includes(w)) {
      typeFound = wCap;
    } else if (CATEGORIES.map((c) => c.toLowerCase()).includes(w)) {
      catFound = CATEGORIES.find((c) => c.toLowerCase() === w);
    } else {
      descParts.push(wCap);
    }
  }

  const desc = descParts.join(" ") || "Gasto";
  const cat  = catFound || guessCategory(desc) || "Otros";

  return {
    id:   Date.now(),
    desc,
    amt:  amount,
    cat,
    type: typeFound,
    date: new Date().toISOString().split("T")[0],
  };
}

// ── Telegram API ──────────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const { default: fetch } = await import("node-fetch");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// ── Comandos ──────────────────────────────────────────────────────────────────

function cmdResumen(chatId, userId) {
  const data     = loadUser(userId);
  const key      = getMonthKey();
  const expenses = data[key] || [];
  if (!expenses.length) return sendMessage(chatId, "📭 Sin gastos registrados este mes.");

  const total  = expenses.reduce((s, e) => s + e.amt, 0);
  const byCat  = {};
  expenses.forEach((e) => { byCat[e.cat] = (byCat[e.cat] || 0) + e.amt; });
  const lines  = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `  • ${cat}: *${fmt(amt)}*`)
    .join("\n");
  const now = new Date();
  sendMessage(chatId,
    `📊 *Resumen ${MONTHS[now.getMonth()]} ${now.getFullYear()}*\n\n${lines}\n\n💰 *Total: ${fmt(total)}*\n_(${expenses.length} registros)_`
  );
}

function cmdLista(chatId, userId) {
  const data     = loadUser(userId);
  const key      = getMonthKey();
  const expenses = (data[key] || []).slice(-8).reverse();
  if (!expenses.length) return sendMessage(chatId, "📭 Sin gastos registrados este mes.");
  const lines = expenses.map((e) => `• ${e.desc} — *${fmt(e.amt)}* _(${e.cat})_`).join("\n");
  sendMessage(chatId, `📋 *Últimos gastos:*\n\n${lines}`);
}

function cmdAyuda(chatId, userId) {
  sendMessage(chatId,
    `ℹ️ *Cómo registrar un gasto:*\n\n` +
    `\`gasto [monto] [descripción] [categoría] [tipo]\`\n\n` +
    `*Ejemplos:*\n` +
    `\`gasto 2800 supermercado\`\n` +
    `\`gasto 15000 alquiler vivienda fijo\`\n` +
    `\`gasto 5500 dentista salud\`\n\n` +
    `*Categorías:* Alimentación, Transporte, Vivienda, Salud, Entretenimiento, Ropa, Educación, Servicios, Restaurantes, Otros\n\n` +
    `*Tipos:* fijo · variable · extraordinario\n\n` +
    `*Comandos:*\n/resumen /lista /ayuda\n\n` +
    `🔑 *Tu ID de usuario:* \`${userId}\`\n_(usalo para vincular la app web)_`
  );
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  if (!update.message) return;

  const msg    = update.message;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text   = (msg.text || "").trim();

  // Autorización
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    return sendMessage(chatId, "⛔ No estás autorizado para usar este bot.");
  }

  if (text.startsWith("/resumen")) return cmdResumen(chatId, userId);
  if (text.startsWith("/lista"))   return cmdLista(chatId, userId);
  if (text.startsWith("/start") || text.startsWith("/ayuda")) return cmdAyuda(chatId, userId);

  if (/^gasto\s+/i.test(text)) {
    const expense = parseExpense(text);
    if (!expense) {
      return sendMessage(chatId, '❌ Formato incorrecto. Probá: `gasto 2800 supermercado`');
    }

    const data = loadUser(userId);
    const key  = getMonthKey();
    if (!data[key]) data[key] = [];
    data[key].push(expense);
    saveUser(userId, data);

    const monthTotal = data[key].reduce((s, e) => s + e.amt, 0);
    return sendMessage(chatId,
      `✅ *Guardado*\n\n` +
      `📝 ${expense.desc}\n` +
      `💵 *${fmt(expense.amt)}*\n` +
      `🏷️ ${expense.cat} · ${expense.type}\n` +
      `📅 ${expense.date}\n\n` +
      `_Total del mes: ${fmt(monthTotal)}_`
    );
  }
});

// ── API para la app web ───────────────────────────────────────────────────────
// GET /api/gastos?userId=123456789&secret=tu-api-secret
// Devuelve todos los gastos del usuario indicado.

app.get("/api/gastos", (req, res) => {
  const { userId, secret } = req.query;

  if (secret !== API_SECRET) {
    return res.status(401).json({ error: "No autorizado" });
  }
  if (!userId) {
    return res.status(400).json({ error: "userId requerido" });
  }

  const safeId = String(userId).replace(/[^0-9]/g, "");
  if (!safeId) return res.status(400).json({ error: "userId inválido" });

  // Solo permitir si está en ALLOWED_IDS (cuando se usa la lista)
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(safeId)) {
    return res.status(403).json({ error: "Usuario no autorizado" });
  }

  const data = loadUser(safeId);
  res.json(data);
});

// ── Registro del webhook en Telegram ─────────────────────────────────────────

async function registerWebhook() {
  if (!BOT_TOKEN || !WEBHOOK_URL) {
    console.log("⚠️  BOT_TOKEN o WEBHOOK_URL no definidos.");
    return;
  }
  const { default: fetch } = await import("node-fetch");
  const url = `${WEBHOOK_URL}/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ url }),
  });
  const json = await res.json();
  console.log("Webhook:", json.ok ? "✅ registrado" : "❌ " + json.description);
}

// ── Arranque ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🤖 Bot corriendo en puerto ${PORT}`);
  await registerWebhook();
});
