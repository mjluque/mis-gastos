// ── account.js — sección "Mi cuenta" ─────────────────────────────────────────

import { serverCfg, users, activeId, activeUser, saveUsers, saveUserData,
         loadUserData, saveServerCfg } from "./storage.js";
import { toast, updateHeader } from "./ui.js";
import { fetchSheetsStatus, connectGoogle, disconnectGoogle, syncToSheet } from "./sheets.js";
import { syncNow } from "./api.js";

// ── Render principal ──────────────────────────────────────────────────────────

export async function renderAccount() {
  const container = document.getElementById("screen-account");
  if (!container) return;

  const u = activeUser();
  if (!u) {
    container.innerHTML = `<div class="card"><div style="font-size:13px;color:var(--text2);padding:8px">
      Sin usuario configurado. Pedile al admin que te agregue.
    </div></div>`;
    return;
  }

  const hasId     = !!u.telegramId;
  const initial   = u.name ? u.name.charAt(0).toUpperCase() : "?";
  const groups    = await fetchUserGroups(u.telegramId);
  const sheets    = hasId ? await fetchSheetsStatus(u.telegramId) : null;
  const lastSync  = localStorage.getItem("gastos_last_sync") || null;
  const serverUrl = serverCfg.url ? new URL(serverCfg.url).hostname : null;

  container.innerHTML = `

    <!-- Encabezado de perfil -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--color-bg-info,#E6F1FB);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:500;color:var(--blue);flex-shrink:0">${initial}</div>
      <div>
        <div style="font-size:16px;font-weight:500;color:var(--text)">${u.name}</div>
        <div style="font-size:12px;color:var(--text2)">Usuario${hasId ? " · ID " + u.telegramId : ""}</div>
      </div>
    </div>

    <!-- Datos personales -->
    <div class="card">
      <div class="section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:12px">Datos personales</div>

      <!-- Nombre editable -->
      <div style="padding:9px 0;border-bottom:0.5px solid var(--border)">
        <div style="font-size:12px;color:var(--text2);margin-bottom:4px">Nombre</div>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="text" id="account-name" value="${u.name}"
            style="max-width:200px;font-size:13px;padding:5px 9px;border-radius:7px;border:0.5px solid var(--border2);background:var(--bg);color:var(--text);font-family:inherit">
          <button class="btn btn-sm" onclick="window.__saveAccountName()"
            style="font-size:11px">Guardar</button>
        </div>
      </div>

      <!-- Telegram ID -->
      <div style="padding:9px 0">
        <div style="font-size:12px;color:var(--text2);margin-bottom:4px">ID de Telegram</div>
        ${hasId
          ? `<div style="display:flex;align-items:center;gap:7px">
               <span style="font-size:13px;font-weight:500;color:var(--text)">${u.telegramId}</span>
               <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="opacity:.35;flex-shrink:0">
                 <rect x="2" y="5.5" width="8" height="5.5" rx="1" fill="var(--text)"/>
                 <path d="M4 5.5V3.5a2 2 0 0 1 4 0v2" stroke="var(--text)" stroke-width="1.2" fill="none"/>
               </svg>
             </div>
             <div style="font-size:11px;color:var(--text3);margin-top:3px">Contactá al admin si necesitás cambiarlo</div>`
          : `<div style="font-size:12px;color:var(--text2);margin-bottom:8px">
               Necesitás tu ID para sincronizar gastos. Mandá
               <code style="font-size:11px;background:var(--bg2);padding:1px 5px;border-radius:4px">/ayuda</code>
               al bot para obtenerlo.
             </div>
             <div style="display:flex;align-items:center;gap:8px">
               <input type="text" id="account-telegram-id" placeholder="ej: 123456789"
                 style="max-width:180px;font-size:13px;padding:5px 9px;border-radius:7px;border:0.5px solid var(--border2);background:var(--bg);color:var(--text);font-family:inherit"
                 inputmode="numeric">
               <button class="btn btn-sm" onclick="window.__saveTelegramId()"
                 style="font-size:11px">Guardar</button>
             </div>`}
      </div>
    </div>

    <!-- Mis grupos -->
    <div class="card">
      <div class="section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:8px">Mis grupos</div>
      ${!hasId
        ? `<div style="font-size:12px;color:var(--text2)">Configurá tu Telegram ID para ver tus grupos.</div>`
        : groups.length === 0
          ? `<div style="font-size:12px;color:var(--text2)">Todavía no participás en ningún grupo.</div>`
          : `<div style="font-size:12px;color:var(--text2);margin-bottom:10px">Grupos en los que participás.</div>
             <div style="display:flex;flex-wrap:wrap;gap:7px">
               ${groups.map(g => `
                 <div style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:12px;background:var(--bg2);color:var(--text2);border:0.5px solid var(--border)">
                   <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                     <circle cx="4.5" cy="3.5" r="1.5" fill="var(--text2)"/>
                     <circle cx="7.5" cy="3.5" r="1.5" fill="var(--text2)"/>
                     <path d="M1 9.5c0-1.93 1.57-3.5 3.5-3.5S8 7.57 8 9.5" stroke="var(--text2)" stroke-width="1.2" fill="none"/>
                     <path d="M7.5 6.5C8.88 6.5 11 7.34 11 9.5" stroke="var(--text2)" stroke-width="1.2" fill="none"/>
                   </svg>
                   ${g.name}
                 </div>`).join("")}
             </div>`}
    </div>

    <!-- Google Sheets -->
    <div class="card">
      <div class="section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:12px">Google Sheets</div>
      ${!hasId
        ? `<div style="font-size:12px;color:var(--text2)">Configurá tu Telegram ID para conectar Google Sheets.</div>`
        : sheets?.connected
          ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
               <div style="display:flex;align-items:center;gap:7px">
                 <div style="width:7px;height:7px;border-radius:50%;background:#1D9E75;flex-shrink:0"></div>
                 <span style="font-size:13px;color:var(--text)">Cuenta conectada</span>
               </div>
               <div style="display:flex;align-items:center;gap:6px">
                 ${sheets.sheetId
                   ? `<a href="https://docs.google.com/spreadsheets/d/${sheets.sheetId}/edit" target="_blank"
                        style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#1e7e45;text-decoration:none">
                        <svg width="13" height="13" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#1e7e45"/><rect x="3" y="4.5" width="10" height="1.3" rx="0.4" fill="white"/><rect x="3" y="7.3" width="10" height="1.3" rx="0.4" fill="white"/><rect x="3" y="10.1" width="6.5" height="1.3" rx="0.4" fill="white"/></svg>
                        Abrir Sheet
                      </a>`
                   : `<span style="font-size:11px;color:var(--text3)">Sheet se creará con el primer gasto</span>`}
                 <button onclick="window.__disconnectGoogle('${u.id}')"
                   style="font-size:10px;padding:2px 6px;border-radius:6px;border:0.5px solid transparent;background:none;color:var(--text3);font-family:inherit;cursor:pointer">
                   Desconectar
                 </button>
               </div>
             </div>
             <div style="height:0.5px;background:var(--border);margin:10px 0"></div>
             <div style="font-size:12px;color:var(--text2);margin-bottom:10px">
               Tus gastos se sincronizan automáticamente cada vez que cargás uno por Telegram.
             </div>
             <button class="btn btn-sm" onclick="window.__syncToSheet('${u.id}')"
               style="width:100%;padding:6px;font-size:12px">
               Sincronizar historial completo
             </button>`
          : `<div style="font-size:13px;color:var(--text2);margin-bottom:14px">
               Conectá tu cuenta de Google para sincronizar tus gastos en un Sheet propio.
               El Sheet se crea con tu primer gasto.
             </div>
             <button class="btn btn-primary" onclick="window.__connectGoogle('${u.id}')" style="width:100%">
               Conectar con Google
             </button>`}
    </div>

    <!-- Estado de sincronización -->
    <div class="card">
      <div class="section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin-bottom:8px">Estado de sincronización</div>

      <div style="background:var(--bg2);border-radius:var(--radius);padding:10px 12px;display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <div style="font-size:12px;font-weight:500;color:var(--text)">Servidor</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${serverUrl || "No configurado"}</div>
        </div>
        <span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;background:var(--color-background-success);color:var(--color-text-success)">
          ${serverCfg.url ? "Conectado" : "Sin conexión"}
        </span>
      </div>

      <div style="background:var(--bg2);border-radius:var(--radius);padding:10px 12px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:12px;font-weight:500;color:var(--text)">Última sincronización</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">${lastSync || "Nunca"}</div>
        </div>
        <button class="btn btn-sm" onclick="window.__syncNowAccount()" style="font-size:11px">
          Sincronizar ahora
        </button>
      </div>
    </div>
  `;
}

// ── Obtener grupos del usuario desde el servidor ───────────────────────────────

async function fetchUserGroups(telegramId) {
  if (!telegramId || !serverCfg.url || !serverCfg.secret) return [];
  try {
    const res = await fetch(
      `${serverCfg.url}/api/user/groups?telegramId=${telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
    );
    if (!res.ok) return [];
    const groupIds = await res.json();

    // Mapear IDs a nombres usando los grupos configurados localmente
    const { groups } = await import("./storage.js");
    return groupIds.map(gid => {
      const found = groups.find(g => g.telegramId === gid);
      return { id: gid, name: found?.name || `Grupo ${gid}` };
    });
  } catch { return []; }
}

// ── Guardar nombre ────────────────────────────────────────────────────────────

export async function saveAccountName() {
  const u    = activeUser();
  const name = document.getElementById("account-name")?.value.trim();
  if (!name) { toast("El nombre no puede estar vacío", false); return; }
  if (name === u?.name) { toast("Sin cambios", false); return; }

  // Actualizar localmente
  const idx = users.findIndex(x => x.id === activeId);
  if (idx >= 0) users[idx].name = name;
  saveUsers();
  updateHeader();

  // Actualizar en servidor si tiene Telegram ID
  if (u?.telegramId && serverCfg.url && serverCfg.secret) {
    try {
      await fetch(
        `${serverCfg.url}/api/user?telegramId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }
      );
    } catch (e) { console.warn("Error actualizando nombre en servidor:", e.message); }
  }

  toast("✓ Nombre actualizado");
  renderAccount();
}

// ── Guardar Telegram ID (solo primera vez) ────────────────────────────────────

export async function saveTelegramId() {
  const u   = activeUser();
  const tid = document.getElementById("account-telegram-id")?.value.trim();
  if (!tid || !/^\d+$/.test(tid)) { toast("ID de Telegram inválido — solo números", false); return; }
  if (u?.telegramId) { toast("El ID ya está configurado", false); return; }

  // Guardar localmente
  const idx = users.findIndex(x => x.id === activeId);
  if (idx >= 0) users[idx].telegramId = tid;
  saveUsers();

  toast("✓ ID guardado · Conectando con el servidor...");

  // Intentar obtener el secret automáticamente
  if (serverCfg.url) {
    try {
      const res    = await fetch(`${serverCfg.url}/api/info?telegramId=${tid}`);
      const json   = await res.json();
      if (json.authorized && json.secret) {
        serverCfg.secret = json.secret;
        saveServerCfg();
        toast("✓ ID guardado · Servidor conectado automáticamente");
      }
    } catch {}
  }

  // Re-renderizar para mostrar estado actualizado
  renderAccount();
}
