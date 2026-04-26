// ── app.js — coordinador principal de la aplicación ─────────────────────────
// Punto de entrada. Orquesta el resto de módulos.

import {
    initStorage, users, groups, activeId, serverCfg,
    setActiveId, saveUsers, saveActive, saveGroups,
    curData, curExpenses, saveUserData, activeUser,
    loadUserData, getConfigKey, serializeConfig, applyConfig
} from "./storage.js";
import { updateHeader, setSyncStatus, toast } from "./ui.js";
import {
    renderResumen, renderList, renderCompare, renderConfig,
    selectedMonths, setSelectedMonths
} from "./renders.js";
import {
    syncNow, syncUserManual, deleteExpenseRemote, saveServerConfig,
    checkServerHealth, fetchRemoteConfig, pushRemoteConfig,
    fetchServerInfo
} from "./api.js";
import { openEditFromBtn, closeEditModal, saveEdit } from "./modals.js";
import { curKey, getKey, CATEGORIES } from "./config.js";

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

// ── Tabs ──────────────────────────────────────────────────────────────────────

export function switchTab(name) {
    document.querySelectorAll(".tab").forEach((t, i) =>
        t.classList.toggle("active", ["resumen", "agregar", "gastos", "comparar", "config"][i] === name)
    );
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    document.getElementById("screen-" + name).classList.add("active");
    if (name === "resumen") renderResumen(currentView, activeGroupId);
    if (name === "gastos") renderList();
    if (name === "comparar") renderCompare();
    if (name === "config") { renderConfig(); checkServerHealth(); }
}

export function refresh() {
    renderResumen(currentView, activeGroupId);
    renderList();
    renderCompare();
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
    if (serverCfg.autoSync) syncNow(true);
}

export function addUser() {
    const name = document.getElementById("new-username").value.trim();
    const tid = document.getElementById("new-userid").value.trim();
    if (!name) { toast("Escribí un nombre", false); return; }
    users.push({ id: "u" + Date.now(), name, telegramId: tid || null });
    saveUsers();
    if (!activeId) { setActiveId(users[users.length - 1].id); saveActive(); }
    document.getElementById("new-username").value = "";
    document.getElementById("new-userid").value = "";
    renderConfig();
    updateHeader();
    updateViewSelector();
    pushConfig();
    toast("✓ Usuario agregado");
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

// ── Gastos ────────────────────────────────────────────────────────────────────

export function addExpense() {
    if (!activeId) { toast("Primero agregá un usuario en Config", false); return; }
    const desc = document.getElementById("new-desc").value.trim();
    const amt = parseFloat(document.getElementById("new-amt").value);
    const cat = document.getElementById("new-cat").value;
    const type = document.getElementById("new-type").value;
    const date = document.getElementById("new-date").value;
    if (!desc || !amt || amt <= 0) { toast("Completá descripción y monto", false); return; }
    const data = curData();
    const key = curKey();
    if (!data[key]) data[key] = [];
    data[key].push({ id: Date.now(), desc, amt, cat, type, date });
    saveUserData(activeId, data);
    document.getElementById("new-desc").value = "";
    document.getElementById("new-amt").value = "";
    toast("✓ Gasto guardado");
    renderResumen(currentView, activeGroupId);
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
    renderResumen(currentView, activeGroupId);
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
async function verifyServerUrl() {
    const url = document.getElementById("server-url").value.trim();
    const statusEl = document.getElementById("server-url-status");
    if (!url) { statusEl.textContent = "Ingresá una URL"; return; }
    statusEl.textContent = "Verificando...";
    try {
        const res = await fetch(`${url}/api/health`);
        const json = await res.json();
        if (json.ok) {
            statusEl.innerHTML = '<span style="color:#1D9E75">✓ Servidor conectado · DB: ' + json.db + (json.sheets ? " · Sheets activo" : "") + "</span>";
        } else {
            statusEl.innerHTML = '<span style="color:#D85A30">⚠ Servidor respondió con error</span>';
        }
    } catch {
        statusEl.innerHTML = '<span style="color:#D85A30">✗ No se pudo conectar</span>';
    }
}

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
window.__renderList = renderList;
window.__saveServerConfig = () => { saveServerConfig(); pushConfig(); };
window.__syncUserManual = syncUserManual;
window.__verifyServerUrl = verifyServerUrl;

// ── Init ──────────────────────────────────────────────────────────────────────

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

    // ── Paso 1: resolver la URL del servidor ──────────────────────────────────
    // Si ya hay una URL guardada localmente, la usamos directamente.
    // Si no, la app queda en espera — el usuario debe ingresarla en Config.
    if (!serverCfg.url) {
        setSyncStatus("idle", "Ingresá la URL del servidor en ⚙ Config");
        renderResumen(currentView, activeGroupId);
        return;
    }

    // ── Paso 2: cargar config remota usando el telegramId del usuario activo ──
    const configKey = getConfigKey();
    if (configKey && serverCfg.secret) {
        setSyncStatus("syncing", "Cargando configuración...");
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
        setSyncStatus("idle", serverCfg.secret ? "Agregá tu ID de Telegram en Config" : "Completá la configuración en ⚙ Config");
    }

    renderResumen(currentView, activeGroupId);

    // ── Paso 3: auto-sync de gastos ───────────────────────────────────────────
    if (serverCfg.autoSync && serverCfg.secret) syncNow(true);
}

init();