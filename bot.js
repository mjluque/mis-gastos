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

const express    = require("express");
const path       = require("path");
const { Pool }   = require("pg");
const { google } = require("googleapis");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const BOT_TOKEN    = process.env.BOT_TOKEN;
const WEBHOOK_URL  = process.env.WEBHOOK_URL;
const API_SECRET   = process.env.API_SECRET || "cambiar-esto";
const ALLOWED_IDS  = process.env.ALLOWED_IDS
  ? process.env.ALLOWED_IDS.split(",").map((id) => id.trim())
  : [];
const SHEET_ID     = process.env.GOOGLE_SHEET_ID;
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
      id:   row.id,
      desc: row.desc,
      amt:  row.amt,
      cat:  row.cat,
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

// Actualiza campos de un gasto existente (solo los que se provean)
async function updateExpense(userId, id, fields) {
  const { desc, amt, cat, type, date } = fields;
  const { rowCount } = await pool.query(
    `UPDATE expenses
     SET description = COALESCE($1, description),
         amount      = COALESCE($2, amount),
         category    = COALESCE($3, category),
         type        = COALESCE($4, type),
         date        = COALESCE($5::date, date)
     WHERE id = $6 AND user_id = $7`,
    [desc || null, amt || null, cat || null, type || null, date || null, id, String(userId)]
  );
  return rowCount > 0;
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
      { title: "Gastos",          headers: ["ID","Usuario","Fecha","Descripción","Monto","Categoría","Tipo","Mes","Año"] },
      { title: "Resumen_Mensual", headers: ["Usuario","Año","Mes","Categoría","Total"] },
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
  const date      = new Date(expense.date);
  const year      = date.getFullYear();
  const monthName = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"][date.getMonth()];
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
  const idx  = rows.findIndex((r, i) => i > 0 && r[0] === userName && String(r[1]) === String(year) && r[2] === monthName && r[3] === cat);
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
const MONTHS     = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const CATEGORIES = ["Alimentación","Transporte","Vivienda","Salud","Entretenimiento","Ropa","Educación","Servicios","Restaurantes","Otros"];

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

function parseExpense(text) {
  const TYPES = ["fijo", "variable", "extraordinario"];
  const parts  = text.trim().toLowerCase().replace(/^gasto\s+/, "").split(/\s+/);
  const amount = parseFloat(parts[0].replace(",", ".").replace(/[^0-9.]/g, ""));
  if (!amount || isNaN(amount)) return null;
  let typeFound = "Variable", catFound = null, dateFound = null;
  const descParts = [];
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i], wCap = w.charAt(0).toUpperCase() + w.slice(1);
    // Detectar fecha en formato DD/MM, DD/MM/YYYY o YYYY-MM-DD
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(w)) {
      const [d, m, y] = w.split("/");
      const year = y ? (y.length === 2 ? "20" + y : y) : new Date().getFullYear();
      dateFound = `${year}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
      dateFound = w;
    } else if (TYPES.includes(w)) {
      typeFound = wCap;
    } else if (CATEGORIES.map((c) => c.toLowerCase()).includes(w)) {
      catFound = CATEGORIES.find((c) => c.toLowerCase() === w);
    } else {
      descParts.push(wCap);
    }
  }
  const desc = descParts.join(" ") || "Gasto";
  const date = dateFound || new Date().toISOString().split("T")[0];
  return { id: Date.now(), desc, amt: amount, cat: catFound || guessCategory(desc) || "Otros", type: typeFound, date };
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
  const now      = new Date();
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
  const lines = expenses.map((e) =>
    `• \`${e.id}\` ${e.desc} — *${fmt(e.amt)}* _(${e.cat} · ${e.date})_`
  ).join("\n");
  sendMessage(chatId, `📋 *Últimos gastos:*\n\n${lines}\n\n_Usá /editar para modificar uno_`);
}

async function cmdEditar(chatId, userId, text) {
  // Formato: /editar <id> <campo> <valor>
  // Ejemplos:
  //   /editar 1710000001 monto 3500
  //   /editar 1710000001 desc almuerzo trabajo
  //   /editar 1710000001 categoria alimentacion
  //   /editar 1710000001 tipo fijo
  //   /editar 1710000001 fecha 15/04
  const parts = text.replace(/^\/editar\s*/i, "").trim().split(/\s+/);
  if (parts.length < 3 || !parts[0]) {
    return sendMessage(chatId,
      `✏️ *Cómo editar un gasto:*\n\n` +
      `\`/editar [id] [campo] [valor]\`\n\n` +
      `*Campos:* desc · monto · categoria · tipo · fecha\n\n` +
      `*Ejemplos:*\n` +
      `\`/editar 1710000001 monto 3500\`\n` +
      `\`/editar 1710000001 desc almuerzo trabajo\`\n` +
      `\`/editar 1710000001 categoria alimentacion\`\n` +
      `\`/editar 1710000001 fecha 15/04\`\n\n` +
      `_Usá /lista para ver los IDs_`
    );
  }

  const [rawId, field, ...valueParts] = parts;
  const id    = parseInt(rawId);
  const value = valueParts.join(" ");

  if (isNaN(id)) return sendMessage(chatId, "❌ ID inválido. Usá /lista para ver los IDs.");

  const fields = {};
  switch (field) {
    case "monto": case "amt": case "amount": {
      const n = parseFloat(value.replace(",", "."));
      if (!n || isNaN(n)) return sendMessage(chatId, "❌ Monto inválido.");
      fields.amt = n; break;
    }
    case "desc": case "descripcion": case "descripción": {
      if (!value) return sendMessage(chatId, "❌ Escribí la nueva descripción.");
      fields.desc = value.charAt(0).toUpperCase() + value.slice(1); break;
    }
    case "categoria": case "categoría": case "cat": {
      const cat = CATEGORIES.find((c) => c.toLowerCase() === value.toLowerCase());
      if (!cat) return sendMessage(chatId, `❌ Categoría inválida.\nOpciones: ${CATEGORIES.join(", ")}`);
      fields.cat = cat; break;
    }
    case "tipo": case "type": {
      const tipos = { fijo: "Fijo", variable: "Variable", extraordinario: "Extraordinario" };
      const t = tipos[value.toLowerCase()];
      if (!t) return sendMessage(chatId, "❌ Tipo inválido. Opciones: fijo, variable, extraordinario");
      fields.type = t; break;
    }
    case "fecha": case "date": {
      let dateFound = null;
      if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(value)) {
        const [d, m, y] = value.split("/");
        const year = y ? (y.length === 2 ? "20" + y : y) : new Date().getFullYear();
        dateFound = `${year}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        dateFound = value;
      }
      if (!dateFound) return sendMessage(chatId, "❌ Fecha inválida. Usá DD/MM o DD/MM/YYYY.");
      fields.date = dateFound; break;
    }
    default:
      return sendMessage(chatId, "❌ Campo inválido. Opciones: desc, monto, categoria, tipo, fecha");
  }

  const updated = await updateExpense(userId, id, fields);
  if (!updated) return sendMessage(chatId, "❌ No encontré ese gasto. Verificá el ID con /lista.");
  sendMessage(chatId, `✅ *Gasto actualizado.*\n_Usá /lista para verificar._`);
}

async function cmdAyuda(chatId, userId) {
  sendMessage(chatId,
    `ℹ️ *Cómo registrar un gasto:*\n\n` +
    `\`gasto [monto] [descripción] [categoría] [tipo] [fecha]\`\n\n` +
    `*Ejemplos:*\n` +
    `\`gasto 2800 supermercado\`\n` +
    `\`gasto 15000 alquiler vivienda fijo\`\n` +
    `\`gasto 500 cafe 20/04\`  ← fecha distinta al día\n` +
    `\`gasto 500 cafe 20/04/2026\`\n\n` +
    `*Categorías:* ${CATEGORIES.join(", ")}\n` +
    `*Tipos:* fijo · variable · extraordinario\n\n` +
    `*Comandos:*\n` +
    `/resumen · /lista · /editar · /ayuda\n\n` +
    `🔑 *Tu ID:* \`${userId}\`\n` +
    `🌐 *App:* ${WEBHOOK_URL || "sin configurar"}`
  );
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  const msg      = update.message;
  const chatId   = msg.chat.id;
  const userId   = String(msg.from.id);
  const text     = (msg.text || "").trim();
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || `User${userId}`;

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId))
    return sendMessage(chatId, "⛔ No estás autorizado.");

  if (text.startsWith("/resumen")) return cmdResumen(chatId, userId);
  if (text.startsWith("/lista"))   return cmdLista(chatId, userId);
  if (text.startsWith("/editar"))  return cmdEditar(chatId, userId, text);
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
  if (!userId)               return res.status(400).json({ error: "userId requerido" });
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

// Editar un gasto existente
app.put("/api/gastos/:id", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId)               return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const id     = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const updated = await updateExpense(safeId, id, req.body);
    if (!updated) return res.status(404).json({ error: "Gasto no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Eliminar un gasto
app.delete("/api/gastos/:id", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId)               return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const id     = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM expenses WHERE id = $1 AND user_id = $2",
      [id, safeId]
    );
    if (!rowCount) return res.status(404).json({ error: "Gasto no encontrado" });
    res.json({ ok: true });
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
  const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
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
