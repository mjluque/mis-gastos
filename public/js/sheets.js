// ── sheets.js — Google Sheets por usuario ────────────────────────────────────

import { serverCfg, activeUser } from "./storage.js";
import { toast } from "./ui.js";

// ── Estado de conexión ────────────────────────────────────────────────────────

export async function fetchSheetsStatus() {
  const u = activeUser();
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return null;
  try {
    const res = await fetch(
      `${serverCfg.url}/api/sheets/status?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
    );
    if (!res.ok) return null;
    return await res.json(); // { connected, sheetId, expiresAt }
  } catch { return null; }
}

// ── Iniciar flujo OAuth ───────────────────────────────────────────────────────
// Abre una ventana nueva con el flujo de Google OAuth.
// Al terminar, Google redirige a /auth/google/callback que muestra una página
// de confirmación. El usuario cierra esa ventana y vuelve a la app.

export function connectGoogle() {
  const u = activeUser();
  if (!u?.telegramId) { toast("Primero agregá tu Telegram ID en Config", false); return; }
  if (!serverCfg.url) { toast("URL del servidor no configurada", false); return; }
  const authUrl = `${serverCfg.url}/auth/google?telegramId=${u.telegramId}`;
  window.open(authUrl, "_blank", "width=600,height=700");
}

// ── Desconectar Google ────────────────────────────────────────────────────────

export async function disconnectGoogle() {
  const u = activeUser();
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return;
  if (!confirm("¿Desconectar tu cuenta de Google? Se eliminarán los tokens guardados. El Sheet no se borrará.")) return;
  try {
    await fetch(
      `${serverCfg.url}/auth/google?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
      { method: "DELETE" }
    );
    toast("✓ Cuenta de Google desconectada");
    await renderSheetsCard();
  } catch { toast("Error al desconectar", false); }
}

// ── Sincronización manual ─────────────────────────────────────────────────────

export async function syncToSheet() {
  const u = activeUser();
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) {
    toast("Sin configuración de servidor", false); return;
  }
  const btn = document.getElementById("btn-sync-sheet");
  if (btn) btn.textContent = "Sincronizando...";
  try {
    const res = await fetch(
      `${serverCfg.url}/api/sheets/sync?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}&userName=${encodeURIComponent(u.name)}`,
      { method: "POST" }
    );
    const json = await res.json();
    if (json.ok) {
      toast(`✓ ${json.count} gastos sincronizados al Sheet`);
      await renderSheetsCard(); // actualizar para mostrar link al Sheet
    } else {
      toast(json.error || "Error al sincronizar", false);
    }
  } catch (e) {
    toast("Error de conexión", false);
  } finally {
    if (btn) btn.textContent = "Sincronizar Sheet ahora";
  }
}

// ── Render de la card de Sheets en Config ─────────────────────────────────────

export async function renderSheetsCard() {
  const card = document.getElementById("sheets-card");
  if (!card) return;

  const u = activeUser();
  if (!u?.telegramId) {
    card.innerHTML = `
      <div class="section-title">Google Sheets</div>
      <div style="font-size:12px;color:var(--text2)">Agregá tu Telegram ID para conectar Google.</div>`;
    return;
  }

  if (!serverCfg.url || !serverCfg.secret) {
    card.innerHTML = `
      <div class="section-title">Google Sheets</div>
      <div style="font-size:12px;color:var(--text2)">Sin conexión al servidor.</div>`;
    return;
  }

  card.innerHTML = `<div class="section-title">Google Sheets</div><div style="font-size:12px;color:var(--text2)">Verificando...</div>`;

  const status = await fetchSheetsStatus();

  if (!status?.connected) {
    card.innerHTML = `
      <div class="section-title">Google Sheets</div>
      <div style="font-size:13px;color:var(--text2);margin-bottom:14px">
        Conectá tu cuenta de Google para sincronizar tus gastos automáticamente en un Sheet propio.
        El Sheet se crea solo cuando registrás tu primer gasto.
      </div>
      <button class="btn btn-primary" onclick="window.__connectGoogle()" style="width:100%">
        Conectar con Google
      </button>`;
    return;
  }

  const sheetUrl = status.sheetId
    ? `https://docs.google.com/spreadsheets/d/${status.sheetId}/edit`
    : null;

  card.innerHTML = `
    <div class="section-title">Google Sheets</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="color:#1D9E75;font-size:13px">● Cuenta de Google conectada</span>
    </div>
    ${sheetUrl
      ? `<div style="margin-bottom:12px;font-size:12px">
           📊 <a href="${sheetUrl}" target="_blank" style="color:var(--blue)">Abrir mi Sheet de gastos</a>
         </div>`
      : `<div style="margin-bottom:12px;font-size:12px;color:var(--text2)">
           El Sheet se creará con tu primer gasto.
         </div>`}
    <div style="display:flex;gap:8px">
      <button id="btn-sync-sheet" class="btn" onclick="window.__syncToSheet()"
              style="flex:2;color:var(--blue);border-color:var(--blue)">
        Sincronizar Sheet ahora
      </button>
      <button class="btn btn-danger btn-sm" onclick="window.__disconnectGoogle()" style="flex:1">
        Desconectar
      </button>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-top:8px">
      La sincronización en tiempo real ocurre cada vez que cargás un gasto por Telegram.
    </div>`;
}
