/**
 * Bot de gastos v4 — PostgreSQL + Google Sheets + app web
 * ─────────────────────────────────────────────────────────
 * Variables de entorno:
 *   DATABASE_URL       → Connection string de Postgres (Railway lo inyecta automáticamente)
 *   BOT_TOKEN          → Token de @BotFather
 *   WEBHOOK_URL        → URL pública (ej: https://mi-app.railway.app)
 *   API_SECRET         → Clave para la app web
 *   ALLOWED_IDS        → IDs de Telegram autorizados, separados por coma
 *   GOOGLE_SHEET_ID    → ID del Google Sheet
 *   GOOGLE_CREDENTIALS → JSON de credenciales de cuenta de servicio (una línea)
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { google } = require("googleapis");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_SECRET = process.env.API_SECRET || "cambiar-esto";
const ALLOWED_IDS = process.env.ALLOWED_IDS
  ? process.env.ALLOWED_IDS.split(",").map((id) => id.trim())
  : [];
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CREDS = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : null;

// ── PostgreSQL ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL requerido en producción (Railway), desactivado en local
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

// Crea la tabla si no existe (idempotente — seguro correr en cada deploy)
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id          BIGINT PRIMARY KEY,
      user_id     TEXT        NOT NULL,
      description TEXT        NOT NULL,
      amount      NUMERIC     NOT NULL,
      category    TEXT        NOT NULL,
      type        TEXT        NOT NULL DEFAULT 'Variable',
      date        DATE        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS expenses_user_id_idx ON expenses (user_id);
    CREATE INDEX IF NOT EXISTS expenses_date_idx    ON expenses (date);
  `);
  console.log("✅ Base de datos lista");
}

// ── Capa de datos (reemplaza loadUser / saveUser) ─────────────────────────────

// Devuelve todos los gastos de un usuario agrupados por clave mes (YYYY-MM)
// en el mismo formato que esperaba la app web: { "2026-03": [...], "2026-04": [...] }
async function loadUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, description AS desc, amount::float AS amt, category AS cat,
            type, date::text
     FROM expenses
     WHERE user_id = $1
     ORDER BY date ASC, created_at ASC`,
    [String(userId)]
  );

  const grouped = {};
  for (const row of rows) {
    // date viene como "2026-04-02" → clave "2026-03" (mes 0-indexed para coincidir con JS)
    const [year, month] = row.date.split("-");
    const jsMonth = String(parseInt(month) - 1).padStart(2, "0");
    const key = `${year}-${jsMonth}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      id: row.id,
      desc: row.desc,
      amt: row.amt,
      cat: row.cat,
      type: row.type,
      date: row.date,
    });
  }
  return grouped;
}

// Inserta un único gasto
async function saveExpense(userId, expense) {
  await pool.query(
    `INSERT INTO expenses (id, user_id, description, amount, category, type, date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [expense.id, String(userId), expense.desc, expense.amt, expense.cat, expense.type, expense.date]
  );
}

// Total del mes para el mensaje de confirmación
async function monthTotal(userId, monthKey) {
  // monthKey es "2026-03" (mes 0-indexed) → convertir a mes 1-indexed para SQL
  const [year, jsMonth] = monthKey.split("-");
  const sqlMonth = String(parseInt(jsMonth) + 1).padStart(2, "0");
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM expenses
     WHERE user_id = $1
       AND to_char(date, 'YYYY-MM') = $2`,
    [String(userId), `${year}-${sqlMonth}`]
  );
  return rows[0].total;
}

// Últimos N gastos del mes actual
async function recentExpenses(userId, limit = 8) {
  const now = new Date();
  const sqlMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const { rows } = await pool.query(
    `SELECT description AS desc, amount::float AS amt, category AS cat, type, date::text
     FROM expenses
     WHERE user_id = $1
       AND to_char(date, 'YYYY-MM') = $2
     ORDER BY date DESC, created_at DESC
     LIMIT $3`,
    [String(userId), sqlMonth, limit]
  );
  return rows;
}

// ── Google Sheets ─────────────────────────────────────────────────────────────

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_CREDS || !SHEET_ID) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: GOOGLE_CREDS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  await ensureSheetStructure();
  return sheetsClient;
}

async function ensureSheetStructure() {
  if (!sheetsClient || !SHEET_ID) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = meta.data.sheets.map((s) => s.properties.title);
    const required = [
      { title: "Gastos", headers: ["ID", "Usuario", "Fecha", "Descripción", "Monto", "Categoría", "Tipo", "Mes", "Año"] },
      { title: "Resumen_Mensual", headers: ["Usuario", "Año", "Mes", "Categoría", "Total"] },
    ];
    const toCreate = required.filter((r) => !existing.includes(r.title));
    if (toCreate.length) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { requests: toCreate.map((s) => ({ addSheet: { properties: { title: s.title } } })) },
      });
    }
    for (const sheet of required) {
      const range = `${sheet.title}!A1:${String.fromCharCode(64 + sheet.headers.length)}1`;
      const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range }).catch(() => null);
      if (!res?.data?.values?.length) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID, range, valueInputOption: "RAW",
          resource: { values: [sheet.headers] },
        });
      }
    }
  } catch (e) {
    console.error("Sheets setup:", e.message);
  }
}

async function appendToSheet(userName, expense) {
  const client = await getSheetsClient();
  if (!client) return;
  const date = new Date(expense.date);
  const year = date.getFullYear();
  const monthName = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"][date.getMonth()];
  try {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: "Gastos!A:I", valueInputOption: "USER_ENTERED",
      resource: { values: [[expense.id, userName, expense.date, expense.desc, expense.amt, expense.cat, expense.type, monthName, year]] },
    });
    await updateMonthlyResume(client, userName, year, monthName, expense.cat, expense.amt);
  } catch (e) {
    console.error("Sheets append:", e.message);
  }
}

async function updateMonthlyResume(client, userName, year, monthName, cat, amt) {
  const res = await client.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Resumen_Mensual!A:E" }).catch(() => null);
  const rows = res?.data?.values || [];
  const idx = rows.findIndex((r, i) => i > 0 && r[0] === userName && String(r[1]) === String(year) && r[2] === monthName && r[3] === cat);
  if (idx >= 0) {
    await client.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `Resumen_Mensual!E${idx + 1}`,
      valueInputOption: "USER_ENTERED", resource: { values: [[(parseFloat(rows[idx][4]) || 0) + amt]] },
    });
  } else {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: "Resumen_Mensual!A:E",
      valueInputOption: "USER_ENTERED", resource: { values: [[userName, year, monthName, cat, amt]] },
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()).padStart(2, "0")}`;
}
function fmt(n) {
  return "$" + Number(n).toLocaleString("es-AR");
}
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const CATEGORIES = ["Alimentación", "Transporte", "Vivienda", "Salud", "Entretenimiento", "Ropa", "Educación", "Servicios", "Restaurantes", "Otros"];

function guessCategory(text) {
  const t = text.toLowerCase();
  if (/super|mercado|carrefour|coto|jumbo|dia|verdura|panadería/.test(t)) return "Alimentación";
  if (/sube|colectivo|tren|taxi|uber|remis|nafta|combustible/.test(t)) return "Transporte";
  if (/alquiler|expensas|luz|edesur|gas|metrogas|agua|internet|cable/.test(t)) return "Vivienda";
  if (/farmacia|médico|medico|obra social|dentista|hospital/.test(t)) return "Salud";
  if (/netflix|spotify|cine|teatro|disney|stream/.test(t)) return "Entretenimiento";
  if (/ropa|zapatillas|calzado|indumentaria/.test(t)) return "Ropa";
  if (/curso|libro|universidad|colegio|escuela/.test(t)) return "Educación";
  if (/resto|restaurant|bar|café|cafe|pizza|sushi/.test(t)) return "Restaurantes";
  return null;
}

function parseExpense(text) {
  const TYPES = ["fijo", "variable", "extraordinario"];
  const parts = text.trim().toLowerCase().replace(/^gasto\s+/, "").split(/\s+/);
  const amount = parseFloat(parts[0].replace(",", ".").replace(/[^0-9.]/g, ""));
  if (!amount || isNaN(amount)) return null;
  let typeFound = "Variable", catFound = null;
  const descParts = [];
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i], wCap = w.charAt(0).toUpperCase() + w.slice(1);
    if (TYPES.includes(w)) { typeFound = wCap; }
    else if (CATEGORIES.map((c) => c.toLowerCase()).includes(w)) { catFound = CATEGORIES.find((c) => c.toLowerCase() === w); }
    else { descParts.push(wCap); }
  }
  const desc = descParts.join(" ") || "Gasto";
  return { id: Date.now(), desc, amt: amount, cat: catFound || guessCategory(desc) || "Otros", type: typeFound, date: new Date().toISOString().split("T")[0] };
}

// ── Telegram API ──────────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const { default: fetch } = await import("node-fetch");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// ── Comandos ──────────────────────────────────────────────────────────────────

async function cmdResumen(chatId, userId) {
  const now = new Date();
  const sqlMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const { rows } = await pool.query(
    `SELECT category AS cat, SUM(amount)::float AS total, COUNT(*) AS cnt
     FROM expenses WHERE user_id = $1 AND to_char(date,'YYYY-MM') = $2
     GROUP BY category ORDER BY total DESC`,
    [String(userId), sqlMonth]
  );
  if (!rows.length) return sendMessage(chatId, "📭 Sin gastos este mes.");
  const total = rows.reduce((s, r) => s + r.total, 0);
  const count = rows.reduce((s, r) => s + parseInt(r.cnt), 0);
  const lines = rows.map((r) => `  • ${r.cat}: *${fmt(r.total)}*`).join("\n");
  sendMessage(chatId, `📊 *Resumen ${MONTHS[now.getMonth()]} ${now.getFullYear()}*\n\n${lines}\n\n💰 *Total: ${fmt(total)}*\n_(${count} registros)_`);
}

async function cmdLista(chatId, userId) {
  const expenses = await recentExpenses(userId, 8);
  if (!expenses.length) return sendMessage(chatId, "📭 Sin gastos este mes.");
  sendMessage(chatId, `📋 *Últimos gastos:*\n\n${expenses.map((e) => `• ${e.desc} — *${fmt(e.amt)}* _(${e.cat})_`).join("\n")}`);
}

async function cmdAyuda(chatId, userId) {
  sendMessage(chatId,
    `ℹ️ *Cómo registrar un gasto:*\n\n\`gasto [monto] [descripción] [categoría] [tipo]\`\n\n` +
    `*Ejemplos:*\n\`gasto 2800 supermercado\`\n\`gasto 15000 alquiler vivienda fijo\`\n\n` +
    `*Categorías:* ${CATEGORIES.join(", ")}\n*Tipos:* fijo · variable · extraordinario\n\n` +
    `*Comandos:* /resumen /lista /ayuda\n\n🔑 *Tu ID:* \`${userId}\`\n🌐 *App:* ${WEBHOOK_URL || "sin configurar"}`
  );
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || "").trim();
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || `User${userId}`;

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId))
    return sendMessage(chatId, "⛔ No estás autorizado.");

  if (text.startsWith("/resumen")) return cmdResumen(chatId, userId);
  if (text.startsWith("/lista")) return cmdLista(chatId, userId);
  if (text.startsWith("/start") || text.startsWith("/ayuda")) return cmdAyuda(chatId, userId);

  if (/^gasto\s+/i.test(text)) {
    const expense = parseExpense(text);
    if (!expense) return sendMessage(chatId, '❌ Formato incorrecto. Probá: `gasto 2800 supermercado`');

    await saveExpense(userId, expense);
    appendToSheet(userName, expense).catch(console.error);

    const total = await monthTotal(userId, getMonthKey());
    return sendMessage(chatId,
      `✅ *Guardado* ${SHEET_ID ? "📊" : ""}\n\n📝 ${expense.desc}\n💵 *${fmt(expense.amt)}*\n🏷️ ${expense.cat} · ${expense.type}\n📅 ${expense.date}\n\n_Total del mes: ${fmt(total)}_`
    );
  }
});

// ── API para app web ──────────────────────────────────────────────────────────

app.get("/api/gastos", async (req, res) => {
  const { userId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(safeId))
    return res.status(403).json({ error: "Usuario no autorizado" });
  try {
    const data = await loadUser(safeId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "postgres", sheets: !!SHEET_ID && !!GOOGLE_CREDS, webhook: !!BOT_TOKEN, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Registro del webhook ──────────────────────────────────────────────────────

async function registerWebhook() {
  if (!BOT_TOKEN || !WEBHOOK_URL) return;
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${WEBHOOK_URL}/webhook` }),
  });
  const json = await res.json();
  console.log("Webhook:", json.ok ? "✅ registrado" : "❌ " + json.description);
}

// ── Arranque ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🤖 Bot corriendo en puerto ${PORT}`);
  await initDB();
  if (SHEET_ID && GOOGLE_CREDS) {
    console.log("📊 Google Sheets: configurado");
    await getSheetsClient().catch(console.error);
  } else {
    console.log("📊 Google Sheets: no configurado (opcional)");
  }
  await registerWebhook();
});



// Al iniciar la app, intentar cargar desde el servidor
// async function syncFromServer() {
//   try {
//     const res = await fetch('https://mis-gastos-production-ca09.up.railway.app/api/gastos');
//     const serverData = await res.json();
//     // Mergear con datos locales (el servidor es fuente de verdad)
//     Object.assign(data, serverData);
//     save();
//     renderResumen();
//   } catch (e) {
//     console.log('Sin conexión al servidor, usando datos locales');
//   }
// }
// syncFromServer();