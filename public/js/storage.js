// ── storage.js — persistencia en localStorage ─────────────────────────────────
// Toda lectura/escritura de localStorage pasa por este módulo.

import { getKey } from "./config.js";

// ── Estado de la app ──────────────────────────────────────────────────────────

// ── Device ID ─────────────────────────────────────────────────────────────────
// Identificador único persistente por dispositivo/navegador.
// Se genera una sola vez y nunca cambia.

export function getDeviceId() {
  let id = localStorage.getItem("gastos_device_id");
  if (!id) {
    id = "dev_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    localStorage.setItem("gastos_device_id", id);
  }
  return id;
}

// ── Clave de config: telegramId del usuario activo ────────────────────────────
// Si el usuario activo tiene telegramId, esa es la clave para /api/config.
// Es permanente, independiente del dispositivo o navegador.

export function getConfigKey() {
  const u = users.find((x) => x.id === activeId);
  return u?.telegramId || null;
}

// ── Serialización de config ───────────────────────────────────────────────────
// La config que se sube/baja del servidor contiene solo metadatos
// (usuarios, grupos, serverCfg). Los gastos van por su propio endpoint.

export function serializeConfig() {
  return { users, groups, serverCfg };
}

export function applyConfig(remote) {
  if (!remote) return;
  if (Array.isArray(remote.users)  && remote.users.length)  users.splice(0, users.length, ...remote.users);
  if (Array.isArray(remote.groups) && remote.groups.length) groups.splice(0, groups.length, ...remote.groups);
  if (remote.serverCfg?.url) Object.assign(serverCfg, remote.serverCfg);
  // Asegurar que activeId siga siendo válido
  if (!users.find((u) => u.id === activeId) && users.length) {
    activeId = users[0].id;
  }
  saveUsers();
  saveGroups();
  saveServerCfg();
  saveActive();
}

// ── Device ID ─────────────────────────────────────────────────────────────────

export let users     = [];
export let groups    = [];
export let activeId  = null;
export let serverCfg = {};

export function setActiveId(id) { activeId = id; }

// ── Usuarios ──────────────────────────────────────────────────────────────────

export function saveUsers() {
  localStorage.setItem("gastos_users", JSON.stringify(users));
}

export function saveActive() {
  localStorage.setItem("gastos_active", activeId || "");
}

export function activeUser() {
  return users.find((u) => u.id === activeId) || null;
}

// ── Grupos ────────────────────────────────────────────────────────────────────

export function saveGroups() {
  localStorage.setItem("gastos_groups", JSON.stringify(groups));
}

// ── Datos de gastos por usuario ───────────────────────────────────────────────

export function loadUserData(uid) {
  if (!uid) return {};
  try { return JSON.parse(localStorage.getItem("gastos_data_" + uid) || "{}"); }
  catch { return {}; }
}

export function saveUserData(uid, data) {
  localStorage.setItem("gastos_data_" + uid, JSON.stringify(data));
}

export function curData() {
  return loadUserData(activeId);
}

export function curExpenses(key) {
  return (curData()[key] || []);
}

// ── Datos de grupos ───────────────────────────────────────────────────────────

export function loadGroupData(groupId) {
  try { return JSON.parse(localStorage.getItem("gastos_group_" + groupId) || "{}"); }
  catch { return {}; }
}

export function saveGroupData(groupId, data) {
  localStorage.setItem("gastos_group_" + groupId, JSON.stringify(data));
}

// ── Configuración del servidor ────────────────────────────────────────────────

export function saveServerCfg() {
  localStorage.setItem("gastos_server", JSON.stringify(serverCfg));
}

// ── Init: cargar todo desde localStorage ─────────────────────────────────────

export function initStorage() {
  try { users     = JSON.parse(localStorage.getItem("gastos_users")  || "[]"); } catch { users = []; }
  try { groups    = JSON.parse(localStorage.getItem("gastos_groups") || "[]"); } catch { groups = []; }
  try { serverCfg = JSON.parse(localStorage.getItem("gastos_server") || "{}"); } catch { serverCfg = {}; }
  activeId = localStorage.getItem("gastos_active") || null;

  // Si el servidor inyectó su URL en el HTML y no hay una guardada localmente, usarla.
  const injectedUrl = window.__SERVER_URL__ || "";
  if (injectedUrl && !serverCfg.url) {
    serverCfg.url = injectedUrl;
    saveServerCfg();
  }
  // Si la URL inyectada cambió respecto a la guardada, actualizar.
  if (injectedUrl && serverCfg.url !== injectedUrl) {
    serverCfg.url = injectedUrl;
    saveServerCfg();
  }

  // Migrar datos de versión anterior (sin usuarios)
  const legacy = localStorage.getItem("gastos_app");
  if (legacy && users.length === 0) {
    const uid = "u_legacy";
    users    = [{ id: uid, name: "Yo", telegramId: null }];
    activeId = uid;
    saveUsers();
    saveActive();
    localStorage.setItem("gastos_data_" + uid, legacy);
  }

  // Datos de demo si no hay nada
  if (users.length === 0) {
    const uid  = "demo1";
    const now  = new Date();
    const dKey = getKey(now.getMonth(), now.getFullYear());
    const prev = getKey(
      now.getMonth() === 0 ? 11 : now.getMonth() - 1,
      now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    );
    users    = [{ id: uid, name: "Demo", telegramId: null }];
    activeId = uid;
    saveUsers();
    saveActive();
    const demo = {};
    demo[dKey] = [
      { id: 1, desc: "Carrefour",  amt: 28500,  cat: "Alimentación",    type: "Variable",      date: `${now.getFullYear()}-04-02` },
      { id: 2, desc: "Alquiler",   amt: 180000, cat: "Vivienda",         type: "Fijo",          date: `${now.getFullYear()}-04-01` },
      { id: 3, desc: "SUBE",       amt: 12000,  cat: "Transporte",       type: "Variable",      date: `${now.getFullYear()}-04-03` },
      { id: 4, desc: "Netflix",    amt: 4200,   cat: "Entretenimiento",  type: "Fijo",          date: `${now.getFullYear()}-04-01` },
      { id: 5, desc: "Farmacia",   amt: 8900,   cat: "Salud",            type: "Variable",      date: `${now.getFullYear()}-04-05` },
    ];
    demo[prev] = [
      { id: 10, desc: "Supermercado", amt: 31000,  cat: "Alimentación", type: "Variable", date: `${now.getFullYear()}-03-03` },
      { id: 11, desc: "Alquiler",     amt: 180000, cat: "Vivienda",     type: "Fijo",     date: `${now.getFullYear()}-03-01` },
      { id: 12, desc: "SUBE",         amt: 9800,   cat: "Transporte",   type: "Variable", date: `${now.getFullYear()}-03-05` },
      { id: 13, desc: "Edesur",       amt: 13200,  cat: "Servicios",    type: "Fijo",     date: `${now.getFullYear()}-03-04` },
    ];
    saveUserData(uid, demo);
  }
}
