// ── admin.js — autenticación y panel admin ───────────────────────────────────
// El token se guarda en sessionStorage (se borra al cerrar el tab).
// Toda comunicación con endpoints /api/admin/* lleva el header Authorization.

import { serverCfg } from "./storage.js";
import { toast } from "./ui.js";

// ── Token de sesión ───────────────────────────────────────────────────────────

export function getAdminToken() {
  return sessionStorage.getItem("admin_token") || null;
}

function setAdminToken(token) {
  if (token) sessionStorage.setItem("admin_token", token);
  else       sessionStorage.removeItem("admin_token");
}

export function isAdminLoggedIn() {
  return !!getAdminToken();
}

// ── Llamadas autenticadas ─────────────────────────────────────────────────────

async function adminFetch(path, options = {}) {
  const token = getAdminToken();
  const res   = await fetch(`${serverCfg.url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  return res;
}

// ── Login ─────────────────────────────────────────────────────────────────────

export async function adminLogin(telegramId, password) {
  if (!serverCfg.url) return { ok: false, error: "URL del servidor no configurada" };
  try {
    const res  = await fetch(`${serverCfg.url}/api/admin/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ telegramId, password }),
    });
    const data = await res.json();
    if (data.ok && data.token) {
      setAdminToken(data.token);
      return { ok: true };
    }
    return { ok: false, error: data.error || "Error desconocido" };
  } catch (e) {
    return { ok: false, error: "No se pudo conectar al servidor" };
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────

export async function adminLogout() {
  try { await adminFetch("/api/admin/logout", { method: "POST" }); } catch {}
  setAdminToken(null);
}

// ── Verificar sesión activa ───────────────────────────────────────────────────

export async function checkAdminSession() {
  if (!getAdminToken()) return false;
  try {
    const res = await adminFetch("/api/admin/me");
    if (!res.ok) { setAdminToken(null); return false; }
    return true;
  } catch { return false; }
}

// ── Datos del panel admin ─────────────────────────────────────────────────────

export async function fetchAdminStats() {
  const res = await adminFetch("/api/admin/stats");
  if (!res.ok) return null;
  return res.json();
}

export async function fetchAdminUsers() {
  const res = await adminFetch("/api/admin/users");
  if (!res.ok) return [];
  return res.json();
}

export async function fetchUserExpenses(telegramId) {
  const res = await adminFetch(`/api/admin/gastos/${telegramId}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchAdminConfig() {
  const res = await adminFetch("/api/admin/config");
  if (!res.ok) return {};
  return res.json();
}

export async function saveAdminConfig(config) {
  const res = await adminFetch("/api/admin/config", {
    method: "POST",
    body:   JSON.stringify(config),
  });
  return res.ok;
}

// ── Render del panel admin ────────────────────────────────────────────────────

export async function renderAdminPanel() {
  const panel = document.getElementById("admin-panel");
  if (!panel) return;

  panel.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text2);font-size:13px">Cargando...</div>';

  const [stats, users, config] = await Promise.all([
    fetchAdminStats(),
    fetchAdminUsers(),
    fetchAdminConfig(),
  ]);

  const apiSecretValue = config.apiSecret || "";

  panel.innerHTML = `
    <!-- Métricas globales -->
    <div class="card">
      <div class="section-title">Métricas globales</div>
      <div class="metrics">
        <div class="metric"><div class="metric-label">Usuarios</div><div class="metric-value">${stats?.users ?? "—"}</div></div>
        <div class="metric"><div class="metric-label">Registros</div><div class="metric-value">${stats?.expenses ?? "—"}</div></div>
        <div class="metric"><div class="metric-label">Total histórico</div><div class="metric-value">${stats ? "$" + Number(stats.total).toLocaleString("es-AR", {maximumFractionDigits:0}) : "—"}</div></div>
        <div class="metric"><div class="metric-label">Grupos activos</div><div class="metric-value">${stats?.groups ?? "—"}</div></div>
      </div>
    </div>

    <!-- Config global -->
    <div class="card">
      <div class="section-title">Configuración global</div>
      <div class="form-group">
        <label class="form-label">API Secret</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="admin-api-secret" value="${apiSecretValue}" placeholder="Clave de acceso a la API" style="flex:1">
          <button class="btn btn-sm" onclick="window.__toggleSecretVisibility()">👁</button>
        </div>
        <div style="font-size:11px;color:var(--text2);margin-top:4px">Esta clave la necesitan los usuarios para sincronizar datos.</div>
      </div>
      <button class="btn btn-primary" onclick="window.__saveAdminConfigFromUI()" style="width:100%">Guardar configuración</button>
    </div>

    <!-- Usuarios registrados -->
    <div class="card">
      <div class="section-title">Usuarios registrados</div>
      ${users.length ? users.map(u => {
        const userList = (u.users || []);
        const names    = userList.map(x => x.name).join(", ") || "Sin nombre";
        return `
          <div class="user-row">
            <div>
              <div style="font-size:13px;font-weight:500">${names}</div>
              <div style="font-size:11px;color:var(--text2)">Telegram ID: ${u.telegram_id} · Actualizado: ${new Date(u.updated_at).toLocaleDateString("es-AR")}</div>
            </div>
            <button class="btn btn-sm btn-info" onclick="window.__adminViewExpenses('${u.telegram_id}', '${names.replace(/'/g, "")}')">Ver gastos</button>
          </div>`;
      }).join("") : '<div class="empty">Sin usuarios registrados aún</div>'}
    </div>

    <!-- Botón logout -->
    <div style="text-align:center;margin-top:8px">
      <button class="btn btn-danger" onclick="window.__adminLogout()">Cerrar sesión admin</button>
    </div>
  `;
}

// ── Render del modal de gastos de un usuario ──────────────────────────────────

export async function renderUserExpensesModal(telegramId, userName) {
  const expenses = await fetchUserExpenses(telegramId);
  const total    = expenses.reduce((s, e) => s + e.amt, 0);
  const fmt      = n => "$" + Number(n).toLocaleString("es-AR", {maximumFractionDigits:0});

  const modal = document.createElement("div");
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px";
  modal.innerHTML = `
    <div style="background:var(--bg);border-radius:var(--radius-lg);padding:20px;width:100%;max-width:520px;max-height:80vh;overflow-y:auto;border:0.5px solid var(--border2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:15px;font-weight:500">Gastos de ${userName}</div>
        <button class="btn btn-sm" onclick="this.closest('[style*=fixed]').remove()">✕</button>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Total histórico: <strong>${fmt(total)}</strong> · ${expenses.length} registros</div>
      ${expenses.length ? expenses.map(e => `
        <div class="expense-row">
          <div class="expense-desc">${e.desc}<div class="expense-sub">${e.cat} · ${e.type} · ${e.date} ${e.scope === "group" ? "· 👥 grupal" : ""}</div></div>
          <div class="expense-amt">${fmt(e.amt)}</div>
        </div>`).join("") : '<div class="empty">Sin gastos</div>'}
    </div>`;
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}
