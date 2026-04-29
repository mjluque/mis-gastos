// ── sheets.js — Google Sheets por usuario ────────────────────────────────────

import { serverCfg, users } from "./storage.js";
import { toast } from "./ui.js";

// El cache de estados vive en window para evitar imports circulares con renders.js
function getCache() { return window.__sheetsStatusCache || {}; }
function setCache(userId, status) {
  if (!window.__sheetsStatusCache) window.__sheetsStatusCache = {};
  window.__sheetsStatusCache[userId] = status;
}

// ── Estado de conexión ────────────────────────────────────────────────────────

export async function fetchSheetsStatus(telegramId) {
  if (!telegramId || !serverCfg.url || !serverCfg.secret) return null;
  try {
    const res = await fetch(
      `${serverCfg.url}/api/sheets/status?telegramId=${telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Carga el estado de Sheets para todos los usuarios y re-renderiza Config
export async function loadAllSheetsStatus() {
  const withTg = users.filter((u) => u.telegramId);
  await Promise.all(withTg.map(async (u) => {
    const status = await fetchSheetsStatus(u.telegramId);
    setCache(u.id, status);
  }));
  if (window.__renderConfig) window.__renderConfig();
}

// ── Conectar Google OAuth ─────────────────────────────────────────────────────

export function connectGoogle(userId) {
  const u = users.find((x) => x.id === userId);
  const telegramId = u?.telegramId;
  if (!telegramId) { toast("Este usuario no tiene ID de Telegram", false); return; }
  if (!serverCfg.url) { toast("URL del servidor no configurada", false); return; }

  const authUrl = `${serverCfg.url}/auth/google?telegramId=${telegramId}`;
  const win = window.open(authUrl, "_blank", "width=600,height=700");

  const timer = setInterval(async () => {
    if (win?.closed) {
      clearInterval(timer);
      const status = await fetchSheetsStatus(telegramId);
      setCache(u.id, status);
      if (window.__renderConfig) window.__renderConfig();
      if (status?.connected) toast("✓ Google conectado correctamente");
    }
  }, 1000);
}

// ── Desconectar Google ────────────────────────────────────────────────────────

export async function disconnectGoogle(userId) {
  const u = users.find((x) => x.id === userId);
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return;
  if (!confirm("¿Desconectar tu cuenta de Google? Los tokens se eliminarán. El Sheet no se borrará.")) return;
  try {
    await fetch(
      `${serverCfg.url}/auth/google?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
      { method: "DELETE" }
    );
    setCache(u.id, { connected: false });
    if (window.__renderConfig) window.__renderConfig();
    toast("✓ Cuenta de Google desconectada");
  } catch { toast("Error al desconectar", false); }
}

// ── Sincronización manual ─────────────────────────────────────────────────────

export async function syncToSheet(userId) {
  const u = users.find((x) => x.id === userId);
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) {
    toast("Sin configuración de servidor", false); return;
  }
  toast("Sincronizando Sheet...");
  try {
    const res = await fetch(
      `${serverCfg.url}/api/sheets/sync?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}&userName=${encodeURIComponent(u.name)}`,
      { method: "POST" }
    );
    const json = await res.json();
    if (json.ok) {
      if (json.sheetId) setCache(u.id, { connected: true, sheetId: json.sheetId });
      if (window.__renderConfig) window.__renderConfig();
      toast(`✓ ${json.count} gastos sincronizados al Sheet`);
    } else {
      toast(json.error || "Error al sincronizar", false);
    }
  } catch { toast("Error de conexión", false); }
}