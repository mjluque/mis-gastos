/**
 * Bot de gastos v3 — multi-usuario + Google Sheets + app web integrada
 * ─────────────────────────────────────────────────────────────────────
 * Variables de entorno:
 *   BOT_TOKEN          → Token de @BotFather
 *   WEBHOOK_URL        → URL pública (ej: https://mi-app.railway.app)
 *   API_SECRET         → Clave para la app web (elegís vos)
 *   ALLOWED_IDS        → IDs de Telegram autorizados, separados por coma
 *   GOOGLE_SHEET_ID    → ID del Google Sheet (en la URL: /d/<ID>/edit)
 *   GOOGLE_CREDENTIALS → JSON de credenciales de cuenta de servicio (en una sola línea)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ── Servir la app web desde /public ──────────────────────────────────────────
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

const DB_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR);

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

// Asegura que existan las hojas necesarias con sus encabezados
async function ensureSheetStructure() {
  if (!sheetsClient || !SHEET_ID) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingSheets = meta.data.sheets.map((s) => s.properties.title);

    const required = [
      {
        title: "Gastos",
        headers: ["ID", "Usuario", "Fecha", "Descripción", "Monto", "Categoría", "Tipo", "Mes", "Año"],
      },
      {
        title: "Resumen_Mensual",
        headers: ["Usuario", "Año", "Mes", "Categoría", "Total"],
      },
    ];

    const toCreate = required.filter((r) => !existingSheets.includes(r.title));

    if (toCreate.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: {
          requests: toCreate.map((s) => ({
            addSheet: { properties: { title: s.title } },
          })),
        },
      });
    }

    // Escribir encabezados en hojas nuevas (o verificar que existan)
    for (const sheet of required) {
      const range = `${sheet.title}!A1:${String.fromCharCode(64 + sheet.headers.length)}1`;
      const existing = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range,
      }).catch(() => null);

      if (!existing?.data?.values?.length) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range,
          valueInputOption: "RAW",
          resource: { values: [sheet.headers] },
        });
      }
    }
  } catch (e) {
    console.error("Error configurando Sheets:", e.message);
  }
}

// Agrega una fila a la hoja Gastos y actualiza Resumen_Mensual
async function appendToSheet(userName, expense) {
  const client = await getSheetsClient();
  if (!client) return;

  const date = new Date(expense.date);
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const monthName = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"][date.getMonth()];

  try {
    // 1. Agregar fila a Gastos
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Gastos!A:I",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          expense.id,
          userName,
          expense.date,
          expense.desc,
          expense.amt,
          expense.cat,
          expense.type,
          monthName,
          year,
        ]],
      },
    });

    // 2. Actualizar Resumen_Mensual (buscar fila existente o agregar)
    await updateMonthlyResume(client, userName, year, monthName, expense.cat, expense.amt);

    console.log(`✓ Sheets: ${userName} - ${expense.desc} $${expense.amt}`);
  } catch (e) {
    console.error("Error escribiendo en Sheets:", e.message);
  }
}

async function updateMonthlyResume(client, userName, year, monthName, cat, amt) {
  // Leer hoja actual
  const res = await client.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Resumen_Mensual!A:E",
  }).catch(() => null);

  const rows = res?.data?.values || [];
  // Buscar fila existente (desde fila 2, la 1 es encabezado)
  const idx = rows.findIndex(
    (r, i) => i > 0 && r[0] === userName && String(r[1]) === String(year) && r[2] === monthName && r[3] === cat
  );

  if (idx >= 0) {
    // Actualizar total existente
    const currentTotal = parseFloat(rows[idx][4]) || 0;
    const newTotal = currentTotal + amt;
    const rowNum = idx + 1; // 1-indexed
    await client.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Resumen_Mensual!E${rowNum}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [[newTotal]] },
    });
  } else {
    // Agregar nueva fila
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Resumen_Mensual!A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[userName, year, monthName, cat, amt]] },
    });
  }
}

// ── Persistencia local ────────────────────────────────────────────────────────

function userFile(userId) {
  return path.join(DB_DIR, `user_${String(userId).replace(/[^0-9]/g, "")}.json`);
}
function loadUser(userId) {
  const f = userFile(userId);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}
function saveUser(userId, data) {
  fs.writeFileSync(userFile(userId), JSON.stringify(data, null, 2));
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

function cmdResumen(chatId, userId) {
  const data = loadUser(userId), key = getMonthKey(), expenses = data[key] || [];
  if (!expenses.length) return sendMessage(chatId, "📭 Sin gastos este mes.");
  const total = expenses.reduce((s, e) => s + e.amt, 0);
  const byCat = {};
  expenses.forEach((e) => { byCat[e.cat] = (byCat[e.cat] || 0) + e.amt; });
  const lines = Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, a]) => `  • ${c}: *${fmt(a)}*`).join("\n");
  const now = new Date();
  sendMessage(chatId, `📊 *Resumen ${MONTHS[now.getMonth()]} ${now.getFullYear()}*\n\n${lines}\n\n💰 *Total: ${fmt(total)}*\n_(${expenses.length} registros)_`);
}

function cmdLista(chatId, userId) {
  const data = loadUser(userId), key = getMonthKey();
  const expenses = (data[key] || []).slice(-8).reverse();
  if (!expenses.length) return sendMessage(chatId, "📭 Sin gastos este mes.");
  sendMessage(chatId, `📋 *Últimos gastos:*\n\n${expenses.map((e) => `• ${e.desc} — *${fmt(e.amt)}* _(${e.cat})_`).join("\n")}`);
}

function cmdAyuda(chatId, userId) {
  sendMessage(chatId,
    `ℹ️ *Cómo registrar un gasto:*\n\n\`gasto [monto] [descripción] [categoría] [tipo]\`\n\n` +
    `*Ejemplos:*\n\`gasto 2800 supermercado\`\n\`gasto 15000 alquiler vivienda fijo\`\n\n` +
    `*Categorías:* ${CATEGORIES.join(", ")}\n*Tipos:* fijo · variable · extraordinario\n\n` +
    `*Comandos:* /resumen /lista /ayuda\n\n🔑 *Tu ID:* \`${userId}\`\n🌐 *App web:* ${WEBHOOK_URL || "sin configurar"}`
  );
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  const msg = update.message, chatId = msg.chat.id, userId = String(msg.from.id);
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

    // Guardar localmente
    const data = loadUser(userId), key = getMonthKey();
    if (!data[key]) data[key] = [];
    data[key].push(expense);
    saveUser(userId, data);

    // Guardar en Google Sheets (en background, no bloquea)
    appendToSheet(userName, expense).catch(console.error);

    const monthTotal = data[key].reduce((s, e) => s + e.amt, 0);
    const sheetIcon = SHEET_ID ? "📊" : "";
    return sendMessage(chatId,
      `✅ *Guardado* ${sheetIcon}\n\n📝 ${expense.desc}\n💵 *${fmt(expense.amt)}*\n🏷️ ${expense.cat} · ${expense.type}\n📅 ${expense.date}\n\n_Total del mes: ${fmt(monthTotal)}_`
    );
  }
});

// ── API para app web ──────────────────────────────────────────────────────────

app.get("/api/gastos", (req, res) => {
  const { userId, secret } = req.query;
  if (secret !== API_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!userId) return res.status(400).json({ error: "userId requerido" });
  const safeId = String(userId).replace(/[^0-9]/g, "");
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(safeId))
    return res.status(403).json({ error: "Usuario no autorizado" });
  res.json(loadUser(safeId));
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    sheets: !!SHEET_ID && !!GOOGLE_CREDS,
    webhook: !!BOT_TOKEN,
    ts: new Date().toISOString(),
  });
});

// ── Registro del webhook ──────────────────────────────────────────────────────

async function registerWebhook() {
  if (!BOT_TOKEN || !WEBHOOK_URL) return;
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${WEBHOOK_URL}/webhook` }),
  });
  const json = await res.json();
  console.log("Webhook:", json.ok ? "✅ registrado" : "❌ " + json.description);
}

// ── Arranque ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🤖 Bot corriendo en puerto ${PORT}`);
  if (SHEET_ID && GOOGLE_CREDS) {
    console.log("📊 Google Sheets: configurado");
    await getSheetsClient().catch(console.error);
  } else {
    console.log("📊 Google Sheets: no configurado (opcional)");
  }
  await registerWebhook();
});


```javascript```
// Al iniciar la app, intentar cargar desde el servidor
async function syncFromServer() {
  try {
    const res = await fetch('https://mis-gastos-production-ca09.up.railway.app/api/gastos');
    const serverData = await res.json();
    // Mergear con datos locales (el servidor es fuente de verdad)
    Object.assign(data, serverData);
    save();
    renderResumen();
  } catch (e) {
    console.log('Sin conexión al servidor, usando datos locales');
  }
}
syncFromServer();
```----```
