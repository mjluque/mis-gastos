/**
 * Bot de gastos v10 — admin + roles + PostgreSQL + Google Sheets + app web
 * ───────────────────────────────────────────────────────────────────────────
 * Variables de entorno:
 *   DATABASE_URL         → Connection string de Postgres (Railway lo inyecta)
 *   BOT_TOKEN            → Token de @BotFather
 *   WEBHOOK_URL          → URL pública (ej: https://mi-app.railway.app)
 *   API_SECRET           → Clave para la app web (solo la usa el admin)
 *   ALLOWED_IDS          → IDs de Telegram autorizados, separados por coma
 *   ADMIN_TELEGRAM_ID    → Telegram ID del usuario admin
 *   ADMIN_PASSWORD_HASH  → Hash bcrypt de la contraseña admin (usar generate-hash.js)
 *   JWT_SECRET           → Clave para firmar tokens de sesión (string largo aleatorio)
 *   GOOGLE_SHEET_ID      → ID del Google Sheet
 *   GOOGLE_CREDENTIALS   → JSON de credenciales de cuenta de servicio (una línea)
 */

require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const path = require("path");
const { Pool } = require("pg");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// Servir index.html con SERVER_URL inyectada como variable global de JS.
// Los demás assets (css, js) se sirven estáticos normalmente.
const PUBLIC_DIR = path.join(__dirname, "public");
const fs = require("fs");

app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const serverUrl = WEBHOOK_URL || "";
  // Inyectar antes del cierre de </head>
  const injected = html.replace(
    "</head>",
    `<script>window.__SERVER_URL__ = ${JSON.stringify(serverUrl)};</script>\n</head>`
  );
  res.setHeader("Content-Type", "text/html");
  res.send(injected);
});

app.use(express.static(PUBLIC_DIR));

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_SECRET = process.env.API_SECRET || "cambiar-esto";
const ALLOWED_IDS = process.env.ALLOWED_IDS
  ? process.env.ALLOWED_IDS.split(",").map((id) => id.trim())
  : [];
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID || null;
const ADMIN_PWD_HASH = process.env.ADMIN_PASSWORD_HASH || null;
const JWT_SECRET = process.env.JWT_SECRET || "cambiar-jwt-secret";
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || null;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || null;
const OAUTH_CALLBACK = `${process.env.WEBHOOK_URL || ""}/auth/google/callback`;

// ── PostgreSQL ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  // Cada statement en su propia llamada para máxima compatibilidad con Railway/Postgres

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id           BIGINT      PRIMARY KEY,
      user_id      TEXT        NOT NULL,
      user_name    TEXT,
      group_id     TEXT        DEFAULT NULL,
      scope        TEXT        NOT NULL DEFAULT 'private',
      description  TEXT        NOT NULL,
      amount       NUMERIC     NOT NULL,
      category     TEXT        NOT NULL,
      type         TEXT        NOT NULL DEFAULT 'Variable',
      date         DATE        NOT NULL,
      is_recurring BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS expenses_user_id_idx  ON expenses (user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS expenses_group_id_idx ON expenses (group_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS expenses_scope_idx    ON expenses (scope)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS expenses_date_idx     ON expenses (date)`);

  // Migración segura: agrega columnas si no existen en tablas preexistentes
  for (const sql of [
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS group_id      TEXT    DEFAULT NULL`,
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS scope         TEXT    NOT NULL DEFAULT 'private'`,
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS user_name     TEXT    DEFAULT NULL`,
    `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_recurring  BOOLEAN NOT NULL DEFAULT FALSE`,
  ]) {
    await pool.query(sql).catch(() => { });
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      telegram_id TEXT        PRIMARY KEY,
      config      JSONB       NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token       TEXT        PRIMARY KEY,
      telegram_id TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_google_tokens (
      telegram_id   TEXT        PRIMARY KEY,
      sheet_id      TEXT        DEFAULT NULL,
      access_token  TEXT,
      refresh_token TEXT        NOT NULL,
      expires_at    TIMESTAMPTZ
    )
  `);

  console.log("✅ Base de datos lista");
}

// ── Capa de datos ─────────────────────────────────────────────────────────────

function currentSqlMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function groupByMonth(rows) {
  const grouped = {};
  for (const row of rows) {
    const [year, month] = row.date.split("-");
    const key = `${year}-${String(parseInt(month) - 1).padStart(2, "0")}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }
  return grouped;
}

// Gastos individuales (scope=private) agrupados por mes
async function loadUserExpenses(userId) {
  const { rows } = await pool.query(
    `SELECT id, description AS desc, amount::float AS amt,
            category AS cat, type, date::text,
            scope, is_recurring
     FROM expenses
     WHERE user_id = $1 AND scope = 'private'
     ORDER BY date ASC, created_at ASC`,
    [String(userId)]
  );
  return groupByMonth(rows);
}

// Gastos de un grupo completo agrupados por mes
async function loadGroupExpenses(groupId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, user_name, description AS desc, amount::float AS amt,
            category AS cat, type, date::text,
            scope, group_id, is_recurring
     FROM expenses
     WHERE group_id = $1 AND scope = 'group'
     ORDER BY date ASC, created_at ASC`,
    [String(groupId)]
  );
  return groupByMonth(rows);
}

// Insertar gasto con contexto
async function saveExpense(userId, userName, groupId, scope, expense) {
  await pool.query(
    `INSERT INTO expenses
       (id, user_id, user_name, group_id, scope, description, amount, category, type, date, is_recurring)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [expense.id, String(userId), userName, groupId || null, scope,
    expense.desc, expense.amt, expense.cat, expense.type, expense.date,
    expense.is_recurring || false]
  );
}

// Actualizar campos de un gasto (solo el propietario puede editar)
async function updateExpense(userId, id, fields) {
  const { desc, amt, cat, type, date, is_recurring } = fields;
  const { rowCount } = await pool.query(
    `UPDATE expenses
     SET description  = COALESCE($1, description),
         amount       = COALESCE($2, amount),
         category     = COALESCE($3, category),
         type         = COALESCE($4, type),
         date         = COALESCE($5::date, date),
         is_recurring = COALESCE($6, is_recurring)
     WHERE id = $7 AND user_id = $8`,
    [desc || null, amt || null, cat || null, type || null, date || null,
    is_recurring !== undefined ? is_recurring : null, id, String(userId)]
  );
  return rowCount > 0;
}

// Total del mes para contexto privado
async function monthTotalPrivate(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses
     WHERE user_id=$1 AND scope='private' AND to_char(date,'YYYY-MM')=$2`,
    [String(userId), currentSqlMonth()]
  );
  return rows[0].total;
}

// Total del mes para contexto grupal
async function monthTotalGroup(groupId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::float AS total FROM expenses
     WHERE group_id=$1 AND scope='group' AND to_char(date,'YYYY-MM')=$2`,
    [String(groupId), currentSqlMonth()]
  );
  return rows[0].total;
}

// Últimos gastos privados del mes
async function recentPrivate(userId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT id, description AS desc, amount::float AS amt,
            category AS cat, type, date::text
     FROM expenses
     WHERE user_id=$1 AND scope='private' AND to_char(date,'YYYY-MM')=$2
     ORDER BY date DESC, created_at DESC LIMIT $3`,
    [String(userId), currentSqlMonth(), limit]
  );
  return rows;
}

// Últimos gastos grupales del mes
async function recentGroup(groupId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, user_name, description AS desc, amount::float AS amt,
            category AS cat, type, date::text
     FROM expenses
     WHERE group_id=$1 AND scope='group' AND to_char(date,'YYYY-MM')=$2
     ORDER BY date DESC, created_at DESC LIMIT $3`,
    [String(groupId), currentSqlMonth(), limit]
  );
  return rows;
}

// Resumen del mes por persona (para grupos)
async function resumeByPerson(groupId) {
  const { rows } = await pool.query(
    `SELECT user_name, category AS cat, SUM(amount)::float AS total
     FROM expenses
     WHERE group_id=$1 AND scope='group' AND to_char(date,'YYYY-MM')=$2
     GROUP BY user_name, category
     ORDER BY user_name, total DESC`,
    [String(groupId), currentSqlMonth()]
  );
  return rows;
}

// ── Google OAuth + Sheets por usuario ────────────────────────────────────────

function makeOAuthClient() {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) return null;
  return new google.auth.OAuth2(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_CALLBACK);
}

// Obtiene un cliente OAuth autenticado para el usuario, renovando el token si es necesario
async function getAuthClientForUser(telegramId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM user_google_tokens WHERE telegram_id = $1",
    [String(telegramId)]
  );
  if (!rows.length || !rows[0].refresh_token) return null;

  const oauth2 = makeOAuthClient();
  if (!oauth2) return null;

  oauth2.setCredentials({
    access_token: rows[0].access_token,
    refresh_token: rows[0].refresh_token,
    expiry_date: rows[0].expires_at ? new Date(rows[0].expires_at).getTime() : null,
  });

  // Renovar si expiró o expira en menos de 5 minutos
  const expiresAt = rows[0].expires_at ? new Date(rows[0].expires_at) : null;
  if (!expiresAt || expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      await pool.query(
        `UPDATE user_google_tokens
         SET access_token = $1, expires_at = $2
         WHERE telegram_id = $3`,
        [credentials.access_token, new Date(credentials.expiry_date), String(telegramId)]
      );
      oauth2.setCredentials(credentials);
    } catch (e) {
      console.error("Error renovando token OAuth:", e.message);
      return null;
    }
  }

  return oauth2;
}

// ── Google Sheets — constantes ────────────────────────────────────────────────

const SHEET_MONTHS = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const MONTH_TAB_HEADERS = ["Fecha","Descripción","Categoría","Tipo","Contexto","Monto"];

function monthTabTitle(key) { // key = "2026-05"
  const [y, m] = key.split("-");
  return `${key} ${SHEET_MONTHS[parseInt(m) - 1]}`;
}

// ── Google Sheets — formato ───────────────────────────────────────────────────

async function applyMonthTabFormat(sheets, spreadsheetId, tabSheetId, numDataRows) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [
      // Encabezado: negrita + fondo gris claro
      { repeatCell: {
        range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.85, blue: 0.85 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      }},
      // Congelar fila 1
      { updateSheetProperties: {
        properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      }},
      // Columna F (Monto): formato numérico con miles
      { repeatCell: {
        range: { sheetId: tabSheetId, startRowIndex: 1, endRowIndex: Math.max(numDataRows + 1, 2), startColumnIndex: 5, endColumnIndex: 6 },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
        fields: "userEnteredFormat.numberFormat",
      }},
    ]},
  });
}

async function applyResumenFormat(sheets, spreadsheetId, resumenSheetId, numDataRows, numCols) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [
      // Encabezado: negrita + fondo verde suave
      { repeatCell: {
        range: { sheetId: resumenSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.71, green: 0.84, blue: 0.70 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      }},
      // Columna A (Categoría): negrita
      { repeatCell: {
        range: { sheetId: resumenSheetId, startRowIndex: 0, endRowIndex: numDataRows + 2, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: "userEnteredFormat.textFormat",
      }},
      // Fila Total (última): negrita + fondo gris muy claro
      { repeatCell: {
        range: { sheetId: resumenSheetId, startRowIndex: numDataRows + 1, endRowIndex: numDataRows + 2, startColumnIndex: 0, endColumnIndex: numCols },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      }},
      // Congelar fila 1 y columna 1
      { updateSheetProperties: {
        properties: { sheetId: resumenSheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
        fields: "gridProperties(frozenRowCount,frozenColumnCount)",
      }},
      // Columnas de montos (B en adelante): formato numérico
      { repeatCell: {
        range: { sheetId: resumenSheetId, startRowIndex: 1, endRowIndex: numDataRows + 2, startColumnIndex: 1, endColumnIndex: numCols },
        cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
        fields: "userEnteredFormat.numberFormat",
      }},
    ]},
  });
}

// ── Google Sheets — crear spreadsheet inicial ─────────────────────────────────

async function createUserSheet(auth, userName) {
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });

  const file = await drive.files.create({
    requestBody: { name: `Mis gastos — ${userName}`, mimeType: "application/vnd.google-apps.spreadsheet" },
    fields: "id",
  });
  const spreadsheetId = file.data.id;

  // Renombrar la hoja por defecto a "Resumen"
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const defaultSheetId = meta.data.sheets[0].properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ updateSheetProperties: { properties: { sheetId: defaultSheetId, title: "Resumen" }, fields: "title" } }] },
  });

  return spreadsheetId;
}

// ── Google Sheets — escribir un gasto (incremental desde Telegram) ────────────

async function appendToUserSheet(telegramId, userName, scope, groupId, expense) {
  const auth = await getAuthClientForUser(telegramId);
  if (!auth) return;

  const sheets = google.sheets({ version: "v4", auth });

  let { rows } = await pool.query("SELECT sheet_id FROM user_google_tokens WHERE telegram_id = $1", [String(telegramId)]);
  let spreadsheetId = rows[0]?.sheet_id;
  if (!spreadsheetId) {
    try {
      spreadsheetId = await createUserSheet(auth, userName);
      await pool.query("UPDATE user_google_tokens SET sheet_id = $1 WHERE telegram_id = $2", [spreadsheetId, String(telegramId)]);
      console.log(`📊 Sheet creado para ${userName}: ${spreadsheetId}`);
    } catch (e) { console.error("Error creando Sheet:", e.message); return; }
  }

  const monthKey = expense.date.substring(0, 7);
  const tabTitle = monthTabTitle(monthKey);
  const ctx = scope === "group" ? `Grupal (${groupId})` : "Personal";

  try {
    // Crear pestaña mensual si no existe
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = meta.data.sheets.find(s => s.properties.title === tabTitle);
    if (!existing) {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: tabTitle } } }] },
      });
      const tabSheetId = res.data.replies[0].addSheet.properties.sheetId;
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `'${tabTitle}'!A1`,
        valueInputOption: "RAW", resource: { values: [MONTH_TAB_HEADERS] },
      });
      await applyMonthTabFormat(sheets, spreadsheetId, tabSheetId, 500);
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId, range: `'${tabTitle}'!A:F`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[expense.date, expense.desc, expense.cat, expense.type, ctx, expense.amt]] },
    });
  } catch (e) { console.error("Error escribiendo en Sheet:", e.message); }
}

// ── Google Sheets — sincronización completa ───────────────────────────────────

async function syncAllExpensesToSheet(telegramId, userName) {
  const auth = await getAuthClientForUser(telegramId);
  if (!auth) return { ok: false, error: "Sin conexión a Google" };

  const { rows: expenses } = await pool.query(
    `SELECT id, description AS desc, amount::float AS amt, category AS cat,
            type, date::text, scope, group_id
     FROM expenses WHERE user_id = $1 ORDER BY date ASC, created_at ASC`,
    [String(telegramId)]
  );
  if (!expenses.length) return { ok: true, count: 0 };

  const sheets = google.sheets({ version: "v4", auth });
  let { rows } = await pool.query("SELECT sheet_id FROM user_google_tokens WHERE telegram_id = $1", [String(telegramId)]);
  let spreadsheetId = rows[0]?.sheet_id;
  if (!spreadsheetId) {
    spreadsheetId = await createUserSheet(auth, userName);
    await pool.query("UPDATE user_google_tokens SET sheet_id = $1 WHERE telegram_id = $2", [spreadsheetId, String(telegramId)]);
  }

  // ── 1. Garantizar que "Resumen" exista y borrar todo lo demás ─────────────
  let meta = await sheets.spreadsheets.get({ spreadsheetId });
  let resumenSheet = meta.data.sheets.find(s => s.properties.title === "Resumen");
  let resumenSheetId;

  if (!resumenSheet) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: "Resumen", index: 0 } } }] },
    });
    resumenSheetId = res.data.replies[0].addSheet.properties.sheetId;
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } else {
    resumenSheetId = resumenSheet.properties.sheetId;
    // Mover Resumen al índice 0
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ updateSheetProperties: { properties: { sheetId: resumenSheetId, index: 0 }, fields: "index" } }] },
    });
  }

  const toDelete = meta.data.sheets.filter(s => s.properties.title !== "Resumen");
  if (toDelete.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: toDelete.map(s => ({ deleteSheet: { sheetId: s.properties.sheetId } })) },
    });
  }

  // ── 2. Agrupar gastos por mes ─────────────────────────────────────────────
  const byMonth = {};
  for (const e of expenses) {
    const key = e.date.substring(0, 7);
    (byMonth[key] = byMonth[key] || []).push(e);
  }
  const monthKeys = Object.keys(byMonth).sort();

  // ── 3. Crear pestañas mensuales con datos y mini-resumen ─────────────────
  for (const key of monthKeys) {
    const tabTitle = monthTabTitle(key);
    const addRes = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests: [{ addSheet: { properties: { title: tabTitle } } }] },
    });
    const tabSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

    const dataRows = byMonth[key].map(e => {
      const ctx = e.scope === "group" ? `Grupal (${e.group_id})` : "Personal";
      return [e.date, e.desc, e.cat, e.type, ctx, e.amt];
    });

    // Encabezados + datos
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tabTitle}'!A1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [MONTH_TAB_HEADERS, ...dataRows] },
    });

    // Mini-resumen al pie (2 filas de separación)
    const catTotals = {};
    for (const e of byMonth[key]) catTotals[e.cat] = (catTotals[e.cat] || 0) + e.amt;
    const monthTotal = byMonth[key].reduce((s, e) => s + e.amt, 0);
    const summaryStartRow = dataRows.length + 3;
    const summaryRows = [
      ["", "", "", "", "Categoría", "Total"],
      ...Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([cat, total]) => ["", "", "", "", cat, total]),
      ["", "", "", "", "Total", monthTotal],
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${tabTitle}'!A${summaryStartRow}`,
      valueInputOption: "USER_ENTERED", resource: { values: summaryRows },
    });

    await applyMonthTabFormat(sheets, spreadsheetId, tabSheetId, dataRows.length);
  }

  // ── 4. Construir pestaña Resumen ──────────────────────────────────────────
  const currentYear = new Date().getFullYear();
  const currentYearMonths = monthKeys.filter(k => k.startsWith(String(currentYear)));
  let resumenMonths = currentYearMonths;
  if (resumenMonths.length < 3) {
    const prev = monthKeys.filter(k => !k.startsWith(String(currentYear)));
    resumenMonths = [...prev.slice(-(3 - resumenMonths.length)), ...resumenMonths];
  }

  const colHeaders = resumenMonths.map(k => {
    const [y, m] = k.split("-");
    return `${SHEET_MONTHS[parseInt(m) - 1].substring(0, 3)} ${y}`;
  });
  const headers = ["Categoría", ...colHeaders, "Total"];

  const catRows = CATEGORIES
    .map(cat => {
      const vals = resumenMonths.map(k => (byMonth[k] || []).filter(e => e.cat === cat).reduce((s, e) => s + e.amt, 0));
      const total = vals.reduce((s, v) => s + v, 0);
      return total > 0 ? [cat, ...vals, total] : null;
    })
    .filter(Boolean);

  const monthTotals = resumenMonths.map(k => (byMonth[k] || []).reduce((s, e) => s + e.amt, 0));
  const grandTotal = monthTotals.reduce((s, v) => s + v, 0);
  const totalRow = ["Total", ...monthTotals, grandTotal];

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: "Resumen!A:Z" });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: "Resumen!A1",
    valueInputOption: "USER_ENTERED",
    resource: { values: [headers, ...catRows, totalRow] },
  });

  await applyResumenFormat(sheets, spreadsheetId, resumenSheetId, catRows.length, headers.length);

  return { ok: true, count: expenses.length, sheetId: spreadsheetId };
}







// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) { return "$" + Number(n).toLocaleString("es-AR"); }

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const CATEGORIES = [
  "Comida",
  "Saliditas & Bares",
  "Vivienda",
  "Auto",
  "Mascotas",
  "Salud & Bienestar",
  "Transporte",
  "Gastos personales",
  "Subscripciones",
  "Viajes",
  "Donaciones",
  "Inversiones",
  "Otros",
];

function guessCategory(text) {
  const t = text.toLowerCase();
  if (/super|mercado|carrefour|coto|jumbo|dia\b|verdura|delivery|deliveries|pedidos|rappi|glovo/.test(t)) return "Comida";
  if (/resto|restaurant|bar|café|cafe|pizza|sushi|cerveza/.test(t)) return "Saliditas & Bares";
  if (/alquiler|expensas|luz|edesur|gas|metrogas|agua|internet|wifi/.test(t)) return "Vivienda";
  if (/nafta|combustible|ypf|shell|axion|seguro|patente|vtv/.test(t)) return "Auto";
  if (/mascota|veterinaria|veterinario|perro|gato/.test(t)) return "Mascotas";
  if (/farmacia|médico|medico|dentista|hospital|clínica|clinica|obra social/.test(t)) return "Salud & Bienestar";
  if (/sube|colectivo|tren|taxi|uber|remis|cabify/.test(t)) return "Transporte";
  if (/netflix|spotify|disney|hbo|flow|stream|suscripcion|suscripción/.test(t)) return "Subscripciones";
  if (/viaje|hotel|vuelo|airbnb/.test(t)) return "Viajes";
  if (/donacion|donación/.test(t)) return "Donaciones";
  return null;
}

function parseInitialExpense(text) {
  const parts = text.trim().replace(/^gasto\s+/i, "").split(/\s+/);
  const amount = parseFloat(parts[0].replace(",", ".").replace(/[^0-9.]/g, ""));
  if (!amount || isNaN(amount)) return null;
  const descParts = [];
  let dateFound = null;
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i];
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(w)) {
      const [d, m, y] = w.split("/");
      const yr = y ? (y.length === 2 ? "20" + y : y) : new Date().getFullYear();
      dateFound = `${yr}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
      dateFound = w;
    } else {
      descParts.push(w.charAt(0).toUpperCase() + w.slice(1));
    }
  }
  return {
    id: Date.now(),
    desc: descParts.join(" ") || "Gasto",
    amt: amount,
    cat: null,
    type: null,
    date: dateFound || new Date().toISOString().split("T")[0],
  };
}

// ── Flujo conversacional de carga de gasto ────────────────────────────────────

const pendingExpenses = new Map(); // userId → { expense, chatId, userName, groupId, scope, step }

function buildCategoryQuestion(expense) {
  const suggested = guessCategory(expense.desc);
  const list = CATEGORIES.map((c, i) => `${i + 1}\\. ${c}`).join("\n");
  const hint = suggested ? `\n\n_Sugerida: *${suggested}*_` : "";
  return `🏷️ *Categoría para "${expense.desc}" — ${fmt(expense.amt)}:*\n\n${list}${hint}\n\n_Ingresá el número o el nombre_`;
}

function buildTypeQuestion(expense) {
  return `📌 *Tipo de gasto para "${expense.desc}":*\n\n1\\. Fijo\n2\\. Variable\n3\\. Extraordinario\n\n_Ingresá el número o el nombre_`;
}

function parseCategoryInput(text) {
  const t = text.trim();
  const n = parseInt(t);
  if (!isNaN(n) && n >= 1 && n <= CATEGORIES.length) return CATEGORIES[n - 1];
  return CATEGORIES.find(c => c.toLowerCase() === t.toLowerCase()) || null;
}

function parseTypeInput(text) {
  const t = text.trim().toLowerCase();
  const n = parseInt(t);
  const TYPES = ["Fijo", "Variable", "Extraordinario"];
  if (!isNaN(n) && n >= 1 && n <= 3) return TYPES[n - 1];
  return { fijo: "Fijo", variable: "Variable", extraordinario: "Extraordinario" }[t] || null;
}

// ── Telegram API ──────────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  const { default: fetch } = await import("node-fetch");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// ── Comandos privados ─────────────────────────────────────────────────────────

async function cmdResumenPrivado(chatId, userId) {
  const now = new Date();
  const { rows } = await pool.query(
    `SELECT category AS cat, SUM(amount)::float AS total, COUNT(*) AS cnt
     FROM expenses WHERE user_id=$1 AND scope='private' AND to_char(date,'YYYY-MM')=$2
     GROUP BY category ORDER BY total DESC`,
    [String(userId), currentSqlMonth()]
  );
  if (!rows.length) return sendMessage(chatId, "📭 Sin gastos personales este mes.");
  const total = rows.reduce((s, r) => s + r.total, 0);
  const count = rows.reduce((s, r) => s + parseInt(r.cnt), 0);
  sendMessage(chatId,
    `📊 *Mis gastos — ${MONTHS[now.getMonth()]} ${now.getFullYear()}*\n\n` +
    rows.map(r => `  • ${r.cat}: *${fmt(r.total)}*`).join("\n") +
    `\n\n💰 *Total: ${fmt(total)}*\n_(${count} registros)_`
  );
}

async function cmdListaPrivado(chatId, userId) {
  const rows = await recentPrivate(userId, 8);
  if (!rows.length) return sendMessage(chatId, "📭 Sin gastos personales este mes.");
  sendMessage(chatId,
    `📋 *Mis últimos gastos:*\n\n` +
    rows.map(e => `• \`${e.id}\` ${e.desc} — *${fmt(e.amt)}* _(${e.cat} · ${e.date})_`).join("\n") +
    `\n\n_Usá /editar para modificar uno_`
  );
}

// ── Comandos grupales ─────────────────────────────────────────────────────────

async function cmdResumenGrupal(chatId, groupId, groupName) {
  const now = new Date();
  const rows = await resumeByPerson(groupId);
  if (!rows.length) return sendMessage(chatId, "📭 Sin gastos grupales este mes.");

  const byPerson = {};
  rows.forEach(r => {
    if (!byPerson[r.user_name]) byPerson[r.user_name] = { total: 0, cats: [] };
    byPerson[r.user_name].total += r.total;
    byPerson[r.user_name].cats.push(`    · ${r.cat}: ${fmt(r.total)}`);
  });

  const totalGrupal = Object.values(byPerson).reduce((s, p) => s + p.total, 0);
  const lines = Object.entries(byPerson)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, p]) => `👤 *${name}*: ${fmt(p.total)}\n${p.cats.join("\n")}`)
    .join("\n\n");

  sendMessage(chatId,
    `📊 *${groupName} — ${MONTHS[now.getMonth()]} ${now.getFullYear()}*\n\n` +
    `${lines}\n\n💰 *Total grupal: ${fmt(totalGrupal)}*`
  );
}

async function cmdListaGrupal(chatId, groupId) {
  const rows = await recentGroup(groupId, 10);
  if (!rows.length) return sendMessage(chatId, "📭 Sin gastos grupales este mes.");
  sendMessage(chatId,
    `📋 *Últimos gastos del grupo:*\n\n` +
    rows.map(e => `• \`${e.id}\` [${e.user_name}] ${e.desc} — *${fmt(e.amt)}* _(${e.cat})_`).join("\n")
  );
}

// ── Comando /editar (solo en privado) ─────────────────────────────────────────

async function cmdEditar(chatId, userId, text) {
  const parts = text.replace(/^\/editar\s*/i, "").trim().split(/\s+/);
  if (parts.length < 3 || !parts[0]) {
    return sendMessage(chatId,
      `✏️ *Cómo editar un gasto:*\n\n\`/editar [id] [campo] [valor]\`\n\n` +
      `*Campos:* desc · monto · categoria · tipo · fecha\n\n` +
      `*Ejemplos:*\n\`/editar 1710000001 monto 3500\`\n\`/editar 1710000001 desc almuerzo\`\n` +
      `\`/editar 1710000001 categoria alimentacion\`\n\`/editar 1710000001 fecha 15/04\`\n\n` +
      `_Usá /lista para ver los IDs_`
    );
  }
  const [rawId, field, ...valueParts] = parts;
  const id = parseInt(rawId), value = valueParts.join(" ");
  if (isNaN(id)) return sendMessage(chatId, "❌ ID inválido.");
  const fields = {};
  switch (field) {
    case "monto": case "amt": {
      const n = parseFloat(value.replace(",", "."));
      if (!n || isNaN(n)) return sendMessage(chatId, "❌ Monto inválido.");
      fields.amt = n; break;
    }
    case "desc": case "descripcion": case "descripción": {
      if (!value) return sendMessage(chatId, "❌ Escribí la nueva descripción.");
      fields.desc = value.charAt(0).toUpperCase() + value.slice(1); break;
    }
    case "categoria": case "categoría": case "cat": {
      const cat = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
      if (!cat) return sendMessage(chatId, `❌ Categoría inválida.\n\n${CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\n_Usá el nombre exacto._`);
      fields.cat = cat; break;
    }
    case "tipo": case "type": {
      const t = { fijo: "Fijo", variable: "Variable", extraordinario: "Extraordinario" }[value.toLowerCase()];
      if (!t) return sendMessage(chatId, "❌ Tipo inválido. Opciones: fijo, variable, extraordinario");
      fields.type = t; break;
    }
    case "fecha": case "date": {
      let df = null;
      if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(value)) {
        const [d, m, y] = value.split("/");
        const yr = y ? (y.length === 2 ? "20" + y : y) : new Date().getFullYear();
        df = `${yr}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) df = value;
      if (!df) return sendMessage(chatId, "❌ Fecha inválida. Usá DD/MM o DD/MM/YYYY.");
      fields.date = df; break;
    }
    default: return sendMessage(chatId, "❌ Campo inválido. Opciones: desc, monto, categoria, tipo, fecha");
  }
  const ok = await updateExpense(userId, id, fields);
  if (!ok) return sendMessage(chatId, "❌ No encontré ese gasto o no te pertenece.");
  sendMessage(chatId, `✅ *Gasto actualizado.*\n_Usá /lista para verificar._`);
}

// ── Comando /ayuda ────────────────────────────────────────────────────────────

async function cmdAyuda(chatId, userId, isGroup) {
  const ctx = isGroup
    ? `📍 *Estás en un grupo.* Los gastos que cargues acá son *grupales* — cualquier miembro del grupo puede verlos con /resumen o /lista.\n\n`
    : `📍 *Estás en privado.* Los gastos que cargues son *solo tuyos*.\n\n`;

  const ids = isGroup
    ? `🔑 *Tu ID:* \`${userId}\`\n👥 *ID del grupo:* \`${chatId}\`\n🌐 *App:* ${WEBHOOK_URL || "sin configurar"}`
    : `🔑 *Tu ID:* \`${userId}\`\n🌐 *App:* ${WEBHOOK_URL || "sin configurar"}`;

  sendMessage(chatId,
    `ℹ️ *Bot de gastos*\n\n${ctx}` +
    `*Cómo registrar:*\n\`gasto [monto] [descripción]\`\n\n` +
    `*Ejemplos:*\n\`gasto 2800 supermercado\`\n\`gasto 15000 alquiler\`\n\`gasto 500 cafe 20/04\`\n\n` +
    `_El bot te preguntará la categoría y el tipo._\n\n` +
    `*Comandos:* /resumen · /lista · /editar · /ayuda\n\n` +
    ids
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
  const isGroup = ["group", "supergroup"].includes(msg.chat.type);
  const groupId = isGroup ? String(msg.chat.id) : null;
  const groupName = isGroup ? (msg.chat.title || "Grupo") : null;
  const scope = isGroup ? "group" : "private";

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId))
    return sendMessage(chatId, "⛔ No estás autorizado.");

  // Los comandos cancelan cualquier carga en progreso
  if (text.startsWith("/")) {
    pendingExpenses.delete(userId);
    if (text.startsWith("/resumen")) return isGroup ? cmdResumenGrupal(chatId, groupId, groupName) : cmdResumenPrivado(chatId, userId);
    if (text.startsWith("/lista")) return isGroup ? cmdListaGrupal(chatId, groupId) : cmdListaPrivado(chatId, userId);
    if (text.startsWith("/editar")) return isGroup
      ? sendMessage(chatId, "✏️ El comando /editar solo está disponible en chat privado con el bot.")
      : cmdEditar(chatId, userId, text);
    if (text.startsWith("/start") || text.startsWith("/ayuda")) return cmdAyuda(chatId, userId, isGroup);
    return;
  }

  // Flujo conversacional: respuesta a pregunta de categoría o tipo
  const pending = pendingExpenses.get(userId);
  if (pending) {
    if (pending.step === "category") {
      const cat = parseCategoryInput(text);
      if (!cat) {
        return sendMessage(chatId,
          `❌ Categoría inválida. Ingresá el número (1-${CATEGORIES.length}) o el nombre.\n\n` +
          buildCategoryQuestion(pending.expense)
        );
      }
      pending.expense.cat = cat;
      pending.step = "type";
      return sendMessage(chatId, buildTypeQuestion(pending.expense));
    }

    if (pending.step === "type") {
      const type = parseTypeInput(text);
      if (!type) {
        return sendMessage(chatId,
          `❌ Tipo inválido. Ingresá 1, 2 o 3.\n\n` + buildTypeQuestion(pending.expense)
        );
      }
      pending.expense.type = type;
      pendingExpenses.delete(userId);

      const { expense, chatId: pChatId, userName: pUserName, groupId: pGroupId, scope: pScope } = pending;
      await saveExpense(userId, pUserName, pGroupId, pScope, expense);
      appendToUserSheet(userId, pUserName, pScope, pGroupId, expense).catch(console.error);

      const total = pScope === "group" ? await monthTotalGroup(pGroupId) : await monthTotalPrivate(userId);
      const icon = pScope === "group" ? "👥" : "👤";
      return sendMessage(pChatId,
        `✅ *Guardado* ${icon}${OAUTH_CLIENT_ID ? " 📊" : ""}\n\n` +
        `📝 ${expense.desc}\n💵 *${fmt(expense.amt)}*\n🏷️ ${expense.cat} · ${expense.type}\n📅 ${expense.date}\n\n` +
        `_Total ${pScope === "group" ? "del grupo" : "personal"} este mes: ${fmt(total)}_`
      );
    }
  }

  if (/^gasto\s+/i.test(text)) {
    const expense = parseInitialExpense(text);
    if (!expense) return sendMessage(chatId, '❌ Formato incorrecto. Probá: `gasto 2800 supermercado`');

    pendingExpenses.set(userId, { expense, chatId, userName, groupId, scope, step: "category" });
    return sendMessage(chatId, buildCategoryQuestion(expense));
  }
});

// ── Autenticación admin ───────────────────────────────────────────────────────

const SESSION_HOURS = 8; // duración de la sesión admin

// Genera un token JWT firmado y lo persiste en la DB
async function createAdminSession(telegramId) {
  const token = jwt.sign(
    { telegramId, role: "admin" },
    JWT_SECRET,
    { expiresIn: `${SESSION_HOURS}h` }
  );
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  await pool.query(
    `INSERT INTO admin_sessions (token, telegram_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token) DO NOTHING`,
    [token, telegramId, expiresAt]
  );
  return token;
}

// Verifica el token JWT y su presencia en la DB (permite invalidación remota)
async function verifyAdminToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT telegram_id FROM admin_sessions
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );
    if (!rows.length) return null;
    return payload;
  } catch { return null; }
}

// Middleware que protege endpoints de admin
async function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const payload = await verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: "Sesión admin requerida" });
  req.adminPayload = payload;
  next();
}

// Limpiar sesiones expiradas (se llama al arrancar y cada hora)
async function cleanExpiredSessions() {
  await pool.query("DELETE FROM admin_sessions WHERE expires_at < NOW()");
}

// ── Endpoints de autenticación ────────────────────────────────────────────────

// POST /api/admin/login — autentica al admin y devuelve un token JWT
app.post("/api/admin/login", async (req, res) => {
  const { telegramId, password } = req.body;
  if (!telegramId || !password)
    return res.status(400).json({ error: "telegramId y password requeridos" });

  if (!ADMIN_TELEGRAM_ID || !ADMIN_PWD_HASH)
    return res.status(503).json({ error: "Admin no configurado en el servidor" });

  if (String(telegramId) !== String(ADMIN_TELEGRAM_ID))
    return res.status(401).json({ error: "Credenciales incorrectas" });

  const valid = await bcrypt.compare(password, ADMIN_PWD_HASH);
  if (!valid)
    return res.status(401).json({ error: "Credenciales incorrectas" });

  const token = await createAdminSession(telegramId);
  res.json({ ok: true, token, expiresIn: SESSION_HOURS * 3600 });
});

// POST /api/admin/logout — invalida el token actual
app.post("/api/admin/logout", requireAdmin, async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  await pool.query("DELETE FROM admin_sessions WHERE token = $1", [token]);
  res.json({ ok: true });
});

// GET /api/admin/me — verifica la sesión activa
app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true, telegramId: req.adminPayload.telegramId });
});

// ── Endpoints exclusivos del admin ────────────────────────────────────────────

// GET /api/admin/users — lista todos los usuarios registrados en app_config
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_id, config->'users' AS users,
              config->'groups' AS groups, updated_at
       FROM app_config ORDER BY updated_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/gastos/:telegramId — ver gastos de cualquier usuario
app.get("/api/admin/gastos/:telegramId", requireAdmin, async (req, res) => {
  const safeId = String(req.params.telegramId).replace(/[^0-9]/g, "");
  try {
    const { rows } = await pool.query(
      `SELECT id, description AS desc, amount::float AS amt,
              category AS cat, type, date::text, scope, group_id, created_at
       FROM expenses WHERE user_id = $1
       ORDER BY date DESC, created_at DESC`,
      [safeId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/stats — métricas globales
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [users, expenses, groups] = await Promise.all([
      pool.query("SELECT COUNT(DISTINCT user_id) AS total FROM expenses"),
      pool.query("SELECT COUNT(*) AS total, SUM(amount)::float AS sum FROM expenses"),
      pool.query("SELECT COUNT(DISTINCT group_id) AS total FROM expenses WHERE scope='group'"),
    ]);
    res.json({
      users: parseInt(users.rows[0].total),
      expenses: parseInt(expenses.rows[0].total),
      total: expenses.rows[0].sum || 0,
      groups: parseInt(groups.rows[0].total),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/config — el admin puede actualizar la config global (API_SECRET, etc.)
// Esta config se guarda en una clave especial reservada para el admin
app.post("/api/admin/config", requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO app_config (telegram_id, config, updated_at)
       VALUES ('__admin__', $1, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/admin/config", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT config FROM app_config WHERE telegram_id = '__admin__'"
    );
    res.json(rows.length ? rows[0].config : {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gestión de usuarios desde el admin ───────────────────────────────────────

// Eliminar usuario y todos sus datos
app.delete("/api/admin/users/:telegramId", requireAdmin, async (req, res) => {
  const safeId = String(req.params.telegramId).replace(/[^0-9]/g, "");
  try {
    await pool.query("DELETE FROM expenses WHERE user_id = $1", [safeId]);
    await pool.query("DELETE FROM app_config WHERE telegram_id = $1", [safeId]);
    await pool.query("DELETE FROM user_google_tokens WHERE telegram_id = $1", [safeId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bloquear/desbloquear usuario (agregar/quitar de ALLOWED_IDS en config)
app.patch("/api/admin/users/:telegramId/block", requireAdmin, async (req, res) => {
  const safeId = String(req.params.telegramId).replace(/[^0-9]/g, "");
  const { blocked } = req.body;
  try {
    // Guardar lista de bloqueados en app_config del admin
    const { rows } = await pool.query(
      "SELECT config FROM app_config WHERE telegram_id = '__admin__'"
    );
    const cfg = rows[0]?.config || {};
    const blocked_ids = new Set(cfg.blocked_ids || []);
    if (blocked) blocked_ids.add(safeId);
    else blocked_ids.delete(safeId);
    cfg.blocked_ids = [...blocked_ids];
    await pool.query(
      `INSERT INTO app_config (telegram_id, config, updated_at)
       VALUES ('__admin__', $1, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(cfg)]
    );
    res.json({ ok: true, blocked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gestión de grupos desde el admin ─────────────────────────────────────────

// Listar grupos (extraídos de los gastos grupales)
app.get("/api/admin/groups", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT group_id, COUNT(DISTINCT user_id) AS members,
              COUNT(*) AS expenses, SUM(amount)::float AS total
       FROM expenses WHERE scope = 'group' AND group_id IS NOT NULL
       GROUP BY group_id ORDER BY total DESC`
    );
    // Enriquecer con nombres de la config del admin
    const { rows: cfgRows } = await pool.query(
      "SELECT config FROM app_config WHERE telegram_id = '__admin__'"
    );
    const groupNames = cfgRows[0]?.config?.group_names || {};
    res.json(rows.map(r => ({
      group_id: r.group_id,
      name: groupNames[r.group_id] || `Grupo ${r.group_id}`,
      members: parseInt(r.members),
      expenses: parseInt(r.expenses),
      total: r.total,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Actualizar nombre de un grupo
app.patch("/api/admin/groups/:groupId", requireAdmin, async (req, res) => {
  const groupId = String(req.params.groupId).replace(/[^0-9\-]/g, "");
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const { rows } = await pool.query(
      "SELECT config FROM app_config WHERE telegram_id = '__admin__'"
    );
    const cfg = rows[0]?.config || {};
    if (!cfg.group_names) cfg.group_names = {};
    cfg.group_names[groupId] = name.trim();
    await pool.query(
      `INSERT INTO app_config (telegram_id, config, updated_at)
       VALUES ('__admin__', $1, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(cfg)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API para app web ──────────────────────────────────────────────────────────

// Info pública del servidor.
// Si el telegramId está en ALLOWED_IDS, devuelve también el secret
// para que la app lo configure automáticamente sin que el usuario lo vea.
app.get("/api/info", (req, res) => {
  const { telegramId } = req.query;
  const safeId = telegramId ? String(telegramId).replace(/[^0-9]/g, "") : null;
  // El secret se entrega a cualquier ID que lo pida.
  // La protección viene del secret mismo — sin él no se puede sincronizar.
  const authorized = !!safeId;
  res.json({
    serverUrl: WEBHOOK_URL || null,
    secret: authorized ? API_SECRET : null,
    authorized,
  });
});

// Actualizar nombre del usuario
app.patch("/api/user", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Nombre requerido" });
  const safeId = String(telegramId).replace(/[^0-9]/g, "");
  try {
    // Actualizar user_name en todos sus gastos
    await pool.query(
      "UPDATE expenses SET user_name = $1 WHERE user_id = $2",
      [name.trim(), safeId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Obtener grupos a los que pertenece un usuario (tiene gastos grupales)
app.get("/api/user/groups", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const safeId = String(telegramId).replace(/[^0-9]/g, "");
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT group_id FROM expenses
       WHERE user_id = $1 AND scope = 'group' AND group_id IS NOT NULL`,
      [safeId]
    );
    res.json(rows.map(r => r.group_id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Configuración por usuario de Telegram
app.get("/api/config", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const safeId = String(telegramId).replace(/[^0-9]/g, "");
  try {
    const { rows } = await pool.query(
      "SELECT config FROM app_config WHERE telegram_id = $1",
      [safeId]
    );
    res.json(rows.length ? rows[0].config : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/config", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const safeId = String(telegramId).replace(/[^0-9]/g, "");
  try {
    await pool.query(
      `INSERT INTO app_config (telegram_id, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telegram_id) DO UPDATE
         SET config = $2, updated_at = NOW()`,
      [safeId, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Gastos individuales
app.get("/api/gastos", async (req, res) => {
  const { userId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  try { res.json(await loadUserExpenses(safeId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Gastos grupales (todos los meses)
app.get("/api/gastos/grupo/:groupId", async (req, res) => {
  const { secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  const safeGroup = String(req.params.groupId).replace(/[^0-9\-]/g, "");
  try { res.json(await loadGroupExpenses(safeGroup)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen grupal por persona (mes actual)
app.get("/api/gastos/grupo/:groupId/resumen", async (req, res) => {
  const { secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  const safeGroup = String(req.params.groupId).replace(/[^0-9\-]/g, "");
  try { res.json(await resumeByPerson(safeGroup)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Editar gasto
app.put("/api/gastos/:id", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const ok = await updateExpense(safeId, id, req.body);
    if (!ok) return res.status(404).json({ error: "Gasto no encontrado" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eliminar gasto
app.delete("/api/gastos/:id", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM expenses WHERE id=$1 AND user_id=$2", [id, safeId]
    );
    if (!rowCount) return res.status(404).json({ error: "Gasto no encontrado" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Endpoints OAuth Google ────────────────────────────────────────────────────

// Inicia el flujo OAuth para el usuario. El telegramId va en el state.
app.get("/auth/google", (req, res) => {
  const { telegramId } = req.query;
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const oauth2 = makeOAuthClient();
  if (!oauth2) return res.status(503).json({ error: "OAuth no configurado en el servidor" });

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",  // forzar para obtener siempre refresh_token
    scope: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
    state: telegramId,
  });
  res.redirect(url);
});

// Google redirige aquí con el código de autorización
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: telegramId, error } = req.query;

  if (error) return res.send(`<h2>Acceso denegado</h2><p>${error}</p>`);
  if (!code || !telegramId) return res.status(400).send("Parámetros inválidos");

  const oauth2 = makeOAuthClient();
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.send("<h2>Error</h2><p>No se obtuvo refresh_token. Intentá desconectar y reconectar tu cuenta de Google.</p>");
    }
    await pool.query(
      `INSERT INTO user_google_tokens (telegram_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE
         SET access_token = $2, refresh_token = $3, expires_at = $4, sheet_id = NULL`,
      [String(telegramId), tokens.access_token, tokens.refresh_token, new Date(tokens.expiry_date)]
    );
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>✅ Google conectado correctamente</h2>
        <p>Tu cuenta de Google quedó vinculada. El Sheet se creará automáticamente cuando registres tu primer gasto.</p>
        <p style="margin-top:20px"><a href="/">Volver a la app</a></p>
      </body></html>
    `);
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.status(500).send(`<h2>Error</h2><p>${e.message}</p>`);
  }
});

// Desconectar Google de un usuario
app.delete("/auth/google", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  await pool.query("DELETE FROM user_google_tokens WHERE telegram_id = $1", [String(telegramId)]);
  res.json({ ok: true });
});

// Estado de conexión OAuth del usuario
app.get("/api/sheets/status", async (req, res) => {
  const { telegramId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  const { rows } = await pool.query(
    "SELECT sheet_id, expires_at FROM user_google_tokens WHERE telegram_id = $1",
    [String(telegramId)]
  );
  if (!rows.length) return res.json({ connected: false });
  res.json({ connected: true, sheetId: rows[0].sheet_id, expiresAt: rows[0].expires_at });
});

// Sincronización manual completa desde la app web
app.post("/api/sheets/sync", async (req, res) => {
  const { telegramId, secret, userName } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!telegramId) return res.status(400).json({ error: "telegramId requerido" });
  try {
    const result = await syncAllExpensesToSheet(String(telegramId), userName || "Usuario");
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle recurrente de un gasto
app.patch("/api/gastos/:id/recurring", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "ID inválido" });
  try {
    const { rows } = await pool.query(
      "SELECT is_recurring FROM expenses WHERE id = $1 AND user_id = $2",
      [id, safeId]
    );
    if (!rows.length) return res.status(404).json({ error: "Gasto no encontrado" });
    const newVal = !rows[0].is_recurring;
    await pool.query(
      "UPDATE expenses SET is_recurring = $1 WHERE id = $2 AND user_id = $3",
      [newVal, id, safeId]
    );
    res.json({ ok: true, is_recurring: newVal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sugerencias recurrentes del mes actual (gastos marcados que no tienen copia este mes)
app.get("/api/gastos/recurrentes", async (req, res) => {
  const { secret, userId } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  const sqlMonth = currentSqlMonth();
  try {
    // Obtener todos los gastos marcados como recurrentes del usuario
    const { rows: recurring } = await pool.query(
      `SELECT DISTINCT ON (description, category)
              id, description AS desc, amount::float AS amt,
              category AS cat, type, is_recurring
       FROM expenses
       WHERE user_id = $1 AND is_recurring = TRUE AND scope = 'private'
       ORDER BY description, category, date DESC`,
      [safeId]
    );
    if (!recurring.length) return res.json([]);

    // Filtrar los que YA fueron cargados este mes (mismo description + category)
    const { rows: thisMonth } = await pool.query(
      `SELECT description, category FROM expenses
       WHERE user_id = $1 AND scope = 'private'
         AND to_char(date, 'YYYY-MM') = $2`,
      [safeId, sqlMonth]
    );
    const alreadyLoaded = new Set(thisMonth.map(r => `${r.description}|${r.category}`));
    const suggestions = recurring.filter(r => !alreadyLoaded.has(`${r.desc}|${r.cat}`));
    res.json(suggestions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "postgres", sheets: !!OAUTH_CLIENT_ID && !!OAUTH_CLIENT_SECRET, webhook: !!BOT_TOKEN, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  await cleanExpiredSessions();
  setInterval(cleanExpiredSessions, 60 * 60 * 1000); // cada hora
  if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET) {
    console.log("📊 Google OAuth: configurado");
  } else {
    console.log("📊 Google OAuth: no configurado (agregar GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET)");
  }
  await registerWebhook();
});