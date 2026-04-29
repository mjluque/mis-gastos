// ── app.js — coordinador principal de la aplicación ─────────────────────────
// Punto de entrada. Orquesta el resto de módulos.

import {
  initStorage, users, groups, activeId, serverCfg,
  setActiveId, saveUsers, saveActive, saveGroups, saveServerCfg,
  curData, curExpenses, saveUserData, activeUser,
  loadUserData, loadGroupData, getConfigKey, serializeConfig, applyConfig
} from "./storage.js";
import { updateHeader, setSyncStatus, toast } from "./ui.js";
import {
  renderResumen, renderList, renderCompare, renderConfig,
  selectedMonths, setSelectedMonths
} from "./renders.js"; import {
  syncNow, syncUserManual, deleteExpenseRemote, saveServerConfig,
  checkServerHealth, fetchRemoteConfig, pushRemoteConfig,
  fetchServerInfo, fetchSecretForUser
} from "./api.js";
import { openEditFromBtn, closeEditModal, saveEdit } from "./modals.js";
import { curKey, getKey, CATEGORIES } from "./config.js";
import {
  adminLogin, adminLogout, checkAdminSession, isAdminLoggedIn,
  renderAdminPanel, renderUserExpensesModal,
  fetchAdminConfig, saveAdminConfig, fetchAdminGroups
} from "./admin.js";
import { connectGoogle, disconnectGoogle, syncToSheet, loadAllSheetsStatus } from "./sheets.js";
import { renderAccount, saveAccountName, saveTelegramId } from "./account.js";

// ── Estado de navegación ──────────────────────────────────────────────────────

let currentView = "personal";
let activeGroupId = null;

// ── Config remota ─────────────────────────────────────────────────────────────
// La clave es el telegramId del usuario activo — permanente e independiente
// del dispositivo o navegador.

async function pushConfig() {
  const key = getConfigKey();
  if (!key) return; // sin telegramId no se puede guardar en el servidor
  await pushRemoteConfig(key, serializeConfig());
}

// ── Pantalla admin ────────────────────────────────────────────────────────────

async function renderAdminScreen() {
  const loginDiv = document.getElementById("admin-login");
  const panelDiv = document.getElementById("admin-panel");
  if (!loginDiv || !panelDiv) return;

  if (isAdminLoggedIn()) {
    // Verificar que la sesión sigue activa en el servidor
    const stillValid = await checkAdminSession();
    if (stillValid) {
      loginDiv.style.display = "none";
      panelDiv.style.display = "block";
      await renderAdminPanel();
      return;
    }
  }
  // Sin sesión: mostrar login
  loginDiv.style.display = "block";
  panelDiv.style.display = "none";
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

// ── Contexto de datos (personal + grupos unificados) ─────────────────────────

function buildContextData() {
  const key = curKey();

  // ── Gastos del mes actual (para Resumen y Lista) ──────────────────────────
  const personal = curExpenses(key).map(e => ({ ...e, scope: e.scope || "private" }));
  const groupExpenses = [];
  for (const g of groups) {
    const gData = loadGroupData(g.id);
    const gExps = (gData[key] || []).map(e => ({
      ...e, scope: "group", group_id: g.telegramId,
    }));
    groupExpenses.push(...gExps);
  }
  const allExpenses = [...personal, ...groupExpenses]
    .sort((a, b) => b.date.localeCompare(a.date));

  // ── Todos los meses históricos (para Comparar) ────────────────────────────
  // Incluye TODOS los meses del usuario, no solo el seleccionado en el header
  const userData = loadUserData(activeId) || {};
  const allData = {};

  // Personal: todos los meses
  for (const [k, exps] of Object.entries(userData)) {
    allData[k] = (exps || []).map(e => ({ ...e, scope: e.scope || "private" }));
  }

  // Grupal: todos los meses de cada grupo
  for (const g of groups) {
    const gData = loadGroupData(g.id);
    for (const [k, exps] of Object.entries(gData)) {
      if (!allData[k]) allData[k] = [];
      allData[k] = [
        ...allData[k],
        ...(exps || []).map(e => ({ ...e, scope: "group", group_id: g.telegramId })),
      ];
    }
  }

  return { view: "unified", expenses: allExpenses, data: allData, groups };
}

export function switchTab(name) {
  const TAB_NAMES = ["resumen", "agregar", "gastos", "comparar", "account", "admin"];
  document.querySelectorAll(".tab").forEach((t, i) =>
    t.classList.toggle("active", TAB_NAMES[i] === name)
  );
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const screen = document.getElementById("screen-" + name);
  if (screen) screen.classList.add("active");
  if (name === "resumen") renderResumen(buildContextData());
  if (name === "agregar") loadRecurringSuggestions();
  if (name === "gastos") renderList(buildContextData());
  if (name === "comparar") renderCompare(buildContextData());
  if (name === "account") renderAccount();
  if (name === "admin") renderAdminScreen();
}

export function refresh() {
  const ctx = buildContextData();
  renderResumen(buildContextData());
  renderList(ctx);
  renderCompare(ctx);
}

// ── Selector de vista personal/grupal ─────────────────────────────────────────

export function updateViewSelector() {
  const sel = document.getElementById("view-selector");
  sel.innerHTML =
    '<option value="personal">👤 Personal</option>' +
    groups.map((g) => `<option value="group_${g.id}">👥 ${g.name}</option>`).join("");
  sel.value = currentView === "group" && activeGroupId ? "group_" + activeGroupId : "personal";
}

export function switchView(val) {
  if (val === "personal") {
    currentView = "personal"; activeGroupId = null;
  } else {
    const uid = val.replace("group_", "");
    const g = groups.find((x) => x.id === uid);
    if (g) { currentView = "group"; activeGroupId = uid; }
  }
  setSelectedMonths([]);
  refresh();
}

// ── Usuarios ──────────────────────────────────────────────────────────────────

export function setActiveUser(uid) {
  setActiveId(uid);
  saveActive();
  setSelectedMonths([]);
  renderConfig();
  updateHeader();
  refresh();
  if (serverCfg.url && serverCfg.secret) syncNow(true);
}

export async function addUser() {
  const name = document.getElementById("new-username").value.trim();
  const tid = document.getElementById("new-userid").value.trim();
  if (!name) { toast("Escribí un nombre", false); return; }

  users.push({ id: "u" + Date.now(), name, telegramId: tid || null });
  saveUsers();
  if (!activeId) { setActiveId(users[users.length - 1].id); saveActive(); }
  document.getElementById("new-username").value = "";
  document.getElementById("new-userid").value = "";

  // Si hay Telegram ID y URL configurada, obtener el secret automáticamente
  if (tid && serverCfg.url) {
    const secret = await fetchSecretForUser(serverCfg.url, tid);
    if (secret && secret !== serverCfg.secret) {
      serverCfg.secret = secret;
      saveServerCfg();
      toast("✓ Usuario agregado · Servidor conectado automáticamente");
    } else if (!secret) {
      toast("✓ Usuario agregado · ID no autorizado en el servidor", false);
    } else {
      toast("✓ Usuario agregado");
    }
  } else {
    toast("✓ Usuario agregado");
  }

  renderConfig();
  updateHeader();
  updateViewSelector();
  pushConfig();
}

export function deleteUser(uid) {
  if (!confirm("¿Eliminar usuario y todos sus datos?")) return;
  const idx = users.findIndex((u) => u.id === uid);
  if (idx >= 0) users.splice(idx, 1);
  localStorage.removeItem("gastos_data_" + uid);
  saveUsers();
  if (activeId === uid) { setActiveId(users[0]?.id || null); saveActive(); }
  renderConfig();
  updateHeader();
  pushConfig();
  refresh();
}

// ── Grupos ────────────────────────────────────────────────────────────────────

export function addGroup() {
  const name = document.getElementById("new-groupname").value.trim();
  const gid = document.getElementById("new-groupid").value.trim();
  if (!name || !gid) { toast("Completá nombre e ID del grupo", false); return; }
  groups.push({ id: "g" + Date.now(), name, telegramId: gid });
  saveGroups();
  document.getElementById("new-groupname").value = "";
  document.getElementById("new-groupid").value = "";
  renderConfig();
  updateViewSelector();
  pushConfig();
  toast("✓ Grupo agregado");
}

export function deleteGroup(uid) {
  if (!confirm("¿Eliminar este grupo?")) return;
  const idx = groups.findIndex((g) => g.id === uid);
  if (idx >= 0) groups.splice(idx, 1);
  saveGroups();
  if (activeGroupId === uid) { activeGroupId = null; currentView = "personal"; }
  renderConfig();
  updateViewSelector();
  pushConfig();
  refresh();
}

// ── Gastos recurrentes — sugerencias ─────────────────────────────────────────

const CAT_COLORS_LOCAL = {
  "Alimentación": "#378ADD", "Transporte": "#1D9E75", "Vivienda": "#D85A30",
  "Salud": "#D4537E", "Entretenimiento": "#534AB7", "Ropa": "#BA7517",
  "Educación": "#639922", "Servicios": "#888780", "Restaurantes": "#185FA5", "Otros": "#3C3489",
};

export async function loadRecurringSuggestions() {
  const container = document.getElementById("recurring-suggestions");
  const list = document.getElementById("suggestions-list");
  if (!container || !list) return;

  const u = activeUser();
  if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) {
    container.style.display = "none";
    return;
  }

  try {
    const res = await fetch(
      `${serverCfg.url}/api/gastos/recurrentes?userId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
    );
    if (!res.ok) { container.style.display = "none"; return; }
    const suggestions = await res.json();

    if (!suggestions.length) { container.style.display = "none"; return; }

    container.style.display = "block";
    list.innerHTML = suggestions.map((s, i) => `
      <div onclick="window.__loadSuggestion(${i})"
        id="suggest-${i}"
        style="display:flex;align-items:center;justify-content:space-between;
               padding:10px 12px;border-radius:var(--radius);
               background:var(--bg);border:0.5px solid var(--border);
               cursor:pointer;margin-bottom:8px;transition:border-color .15s"
        onmouseover="this.style.borderColor='var(--border2)'"
        onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="width:8px;height:8px;border-radius:50%;background:${CAT_COLORS_LOCAL[s.cat] || "#888"};flex-shrink:0"></div>
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--text)">${s.desc}</div>
            <div style="font-size:11px;color:var(--text2)">${s.cat} · ${s.type}</div>
          </div>
        </div>
        <div style="font-size:13px;font-weight:500;color:var(--text);white-space:nowrap">
          $${Number(s.amt).toLocaleString("es-AR", { maximumFractionDigits: 0 })}
        </div>
      </div>`).join("");

    // Guardar sugerencias en window para acceso desde loadSuggestion
    window.__currentSuggestions = suggestions;

  } catch { container.style.display = "none"; }
}

export function loadSuggestion(index) {
  const suggestions = window.__currentSuggestions || [];
  const s = suggestions[index];
  if (!s) return;

  // Resaltar la tarjeta seleccionada
  document.querySelectorAll("[id^='suggest-']").forEach((el, i) => {
    el.style.outline = i === index ? "1.5px solid var(--text)" : "none";
  });

  // Pre-cargar el formulario
  document.getElementById("new-desc").value = s.desc;
  document.getElementById("new-amt").value = s.amt;
  document.getElementById("new-cat").value = s.cat;
  document.getElementById("new-type").value = s.type;
  if (document.getElementById("new-recurring"))
    document.getElementById("new-recurring").checked = true;
  document.getElementById("new-amt").focus();
}

// Toggle recurrente desde la Lista
export async function toggleRecurring(expenseId, btnEl) {
  const u = activeUser();

  // Actualizar visual inmediatamente (optimistic UI)
  const svg = btnEl.querySelector("svg");
  const paths = svg.querySelectorAll("path");
  const isOn = paths[0].getAttribute("stroke") === "#1D9E75";
  const newColor = isOn ? "var(--text3)" : "#1D9E75";
  paths.forEach(p => p.setAttribute("stroke", newColor));

  // Actualizar en localStorage
  const data = curData();
  for (const key of Object.keys(data)) {
    const exp = data[key].find(e => String(e.id) === String(expenseId));
    if (exp) { exp.is_recurring = !isOn; break; }
  }
  saveUserData(activeId, data);

  // Actualizar en servidor
  if (u?.telegramId && serverCfg.url && serverCfg.secret) {
    try {
      await fetch(
        `${serverCfg.url}/api/gastos/${expenseId}/recurring?userId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
        { method: "PATCH" }
      );
    } catch (e) { console.warn("Error actualizando recurrente:", e.message); }
  }

  toast(!isOn ? "✓ Marcado como recurrente" : "Quitado de recurrentes");
}

// ── Gastos ────────────────────────────────────────────────────────────────────

export function addExpense() {
  if (!activeId) { toast("Primero agregá tu usuario en Mi cuenta", false); return; }
  const desc = document.getElementById("new-desc").value.trim();
  const amt = parseFloat(document.getElementById("new-amt").value);
  const cat = document.getElementById("new-cat").value;
  const type = document.getElementById("new-type").value;
  const date = document.getElementById("new-date").value;
  const isRecurring = document.getElementById("new-recurring")?.checked || false;
  if (!desc || !amt || amt <= 0) { toast("Completá descripción y monto", false); return; }
  const data = curData();
  const key = curKey();
  if (!data[key]) data[key] = [];
  const expense = { id: Date.now(), desc, amt, cat, type, date, is_recurring: isRecurring };
  data[key].push(expense);
  saveUserData(activeId, data);
  document.getElementById("new-desc").value = "";
  document.getElementById("new-amt").value = "";
  if (document.getElementById("new-recurring"))
    document.getElementById("new-recurring").checked = false;
  // Si fue marcado como recurrente, removerlo de sugerencias si estaba
  if (isRecurring) loadRecurringSuggestions();
  toast("✓ Gasto guardado");
  renderResumen(buildContextData());
}

export function quickAdd(desc, cat) {
  document.getElementById("new-desc").value = desc;
  document.getElementById("new-cat").value = cat;
  document.getElementById("new-amt").focus();
  switchTab("agregar");
}

export function deleteExpense(id) {
  if (!confirm("¿Eliminar este gasto?")) return;
  const data = curData();
  for (const key of Object.keys(data)) {
    const idx = data[key].findIndex((e) => String(e.id) === String(id));
    if (idx >= 0) { data[key].splice(idx, 1); break; }
  }
  saveUserData(activeId, data);
  deleteExpenseRemote(id);
  renderList();
  renderResumen(buildContextData());
  toast("Gasto eliminado");
}

export function toggleMonth(k) {
  const arr = [...selectedMonths];
  const idx = arr.indexOf(k);
  if (idx >= 0) arr.splice(idx, 1);
  else if (arr.length < 5) arr.push(k);
  arr.sort();
  setSelectedMonths(arr);
  renderCompare();
}

// ── Exponer funciones al HTML (onclick en elementos generados dinámicamente) ──
// Los módulos ES6 no exponen globales automáticamente, así que los registramos
// en window explícitamente solo para los handlers inline del DOM.

// Verificar URL del servidor antes de guardar
window.__refresh = refresh;
window.__renderConfig = renderConfig;
window.__switchTab = switchTab;
window.__switchView = switchView;
window.__syncNow = () => syncNow(false);
window.__addExpense = addExpense;
window.__quickAdd = quickAdd;
window.__deleteExpense = deleteExpense;
window.__toggleMonth = toggleMonth;
window.__setActiveUser = setActiveUser;
window.__deleteUser = deleteUser;
window.__addUser = addUser;
window.__addGroup = addGroup;
window.__deleteGroup = deleteGroup;
window.__openEditFromBtn = openEditFromBtn;
window.__closeEditModal = closeEditModal;
window.__saveEdit = saveEdit;
window.__renderList = () => renderList(buildContextData());
window.__refreshCompare = () => renderCompare(buildContextData());
window.__saveServerConfig = () => { saveServerConfig(); pushConfig(); };
window.__syncUserManual = syncUserManual;
window.__connectGoogle = (userId) => connectGoogle(userId);
window.__disconnectGoogle = (userId) => disconnectGoogle(userId);
window.__syncToSheet = (userId) => syncToSheet(userId);
window.__saveAccountName = saveAccountName;
window.__saveTelegramId = saveTelegramId;
window.__syncNowAccount = () => syncNow(false);
window.__loadSuggestion = loadSuggestion;
window.__toggleRecurring = (id, btn) => toggleRecurring(id, btn);

// ── Admin ──────────────────────────────────────────────────────────────────────
window.__adminLoginFromUI = async () => {
  const telegramId = document.getElementById("admin-telegram-id").value.trim();
  const password = document.getElementById("admin-password").value;
  const errEl = document.getElementById("admin-login-error");
  errEl.textContent = "Verificando...";
  const result = await adminLogin(telegramId, password);
  if (result.ok) {
    errEl.textContent = "";
    renderAdminScreen();
  } else {
    errEl.textContent = result.error || "Credenciales incorrectas";
    document.getElementById("admin-password").value = "";
  }
};

window.__adminLogout = async () => {
  await adminLogout();
  renderAdminScreen();
  toast("Sesión admin cerrada");
};

window.__adminViewExpenses = (telegramId, userName) => {
  renderUserExpensesModal(telegramId, userName);
};

window.__adminToggleBlock = async (telegramId, block) => {
  const res = await fetch(`${serverCfg.url}/api/admin/users/${telegramId}/block`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionStorage.getItem("admin_token")}` },
    body: JSON.stringify({ blocked: block }),
  });
  if (res.ok) { toast(block ? "Usuario bloqueado" : "Usuario desbloqueado"); renderAdminPanel(); }
  else toast("Error al actualizar", false);
};

window.__adminDeleteUser = async (telegramId, name) => {
  if (!confirm(`¿Eliminar a ${name} y todos sus datos? Esta acción no se puede deshacer.`)) return;
  const res = await fetch(`${serverCfg.url}/api/admin/users/${telegramId}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${sessionStorage.getItem("admin_token")}` },
  });
  if (res.ok) { toast("Usuario eliminado"); renderAdminPanel(); }
  else toast("Error al eliminar", false);
};

window.__adminSaveGroupName = async (groupId) => {
  const name = document.getElementById(`group-name-${groupId}`)?.value.trim();
  if (!name) { toast("El nombre no puede estar vacío", false); return; }
  const res = await fetch(`${serverCfg.url}/api/admin/groups/${groupId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${sessionStorage.getItem("admin_token")}` },
    body: JSON.stringify({ name }),
  });
  if (res.ok) toast("✓ Nombre del grupo actualizado");
  else toast("Error al guardar", false);
};

window.__saveAdminConfigFromUI = async () => {
  const secret = document.getElementById("admin-api-secret").value.trim();
  const ok = await saveAdminConfig({ apiSecret: secret });
  toast(ok ? "✓ Configuración guardada" : "Error al guardar", ok);
};

window.__toggleSecretVisibility = () => {
  const input = document.getElementById("admin-api-secret");
  input.type = input.type === "password" ? "text" : "password";
};

// ── Init ──────────────────────────────────────────────────────────────────────

function updateContextSelectors() {
  // Agrega grupos al filtro de contexto en Lista y en Comparar
  const groupOptions = groups.map(g =>
    `<option value="${g.telegramId}">&#128101; ${g.name}</option>`
  ).join("");

  const ctxSel = document.getElementById("filter-ctx");
  if (ctxSel) {
    ctxSel.innerHTML =
      `<option value="">Todos los contextos</option>` +
      `<option value="__personal__">&#128100; Personal</option>` +
      groupOptions;
  }

  const cmpSel = document.getElementById("compare-ctx");
  if (cmpSel) {
    const current = cmpSel.value;
    cmpSel.innerHTML =
      `<option value="__personal__">&#128100; Personal</option>` +
      groupOptions;
    if (current && [...cmpSel.options].some(o => o.value === current))
      cmpSel.value = current;
  }
}

async function init() {
  initStorage();

  // Inicializar selectores de fecha
  const now = new Date();
  document.getElementById("month-select").value = now.getMonth();
  document.getElementById("year-select").value = now.getFullYear();
  document.getElementById("new-date").value = now.toISOString().split("T")[0];
  document.getElementById("month-select").addEventListener("change", refresh);
  document.getElementById("year-select").addEventListener("change", refresh);

  updateHeader();
  updateViewSelector();
  updateContextSelectors();

  // ── Paso 1: resolver la URL del servidor ──────────────────────────────────
  // Si ya hay una URL guardada localmente, la usamos directamente.
  // Si no, la app queda en espera — el usuario debe ingresarla en Config.
  if (!serverCfg.url) {
    setSyncStatus("idle", "Ingresá la URL del servidor en ⚙ Config");
    renderResumen(buildContextData());
    return;
  }

  // ── Paso 2: cargar config remota usando el telegramId del usuario activo ──
  const configKey = getConfigKey();
  if (configKey && serverCfg.url) {
    setSyncStatus("syncing", "Cargando configuración...");
    // Obtener secret si no lo tenemos aún
    if (!serverCfg.secret) {
      const secret = await fetchSecretForUser(serverCfg.url, configKey);
      if (secret) { serverCfg.secret = secret; saveServerCfg(); }
    }
    if (serverCfg.secret) {
      const remote = await fetchRemoteConfig(configKey);
      if (remote) {
        applyConfig(remote);
        updateHeader();
        updateViewSelector();
        setSyncStatus("ok", "Configuración cargada");
      } else {
        setSyncStatus("idle", "Sin configuración remota aún");
      }
    } else {
      setSyncStatus("err", "Telegram ID no autorizado en el servidor");
    }
  } else if (!serverCfg.url) {
    setSyncStatus("err", "Sin servidor — contactá al administrador");
  } else {
    setSyncStatus("idle", "Agregá tu Telegram ID en ⚙ Config");
  }

  renderResumen(buildContextData());

  // Mostrar tab admin siempre (el login lo protege)
  const tabAdmin = document.getElementById("tab-admin");
  if (tabAdmin) tabAdmin.style.display = "";

  // ── Paso 3: auto-sync siempre activo al abrir ────────────────────────────
  if (serverCfg.url && serverCfg.secret) syncNow(true);
}

init();