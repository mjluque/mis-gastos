// ── storage.js — persistencia en localStorage ─────────────────────────────────
// Toda lectura/escritura de localStorage pasa por este módulo.

import { getKey } from "./config.js";

// ── Estado de la app ──────────────────────────────────────────────────────────

export let users = [];
export let groups = [];
export let activeId = null;
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
    try { users = JSON.parse(localStorage.getItem("gastos_users") || "[]"); } catch { users = []; }
    try { groups = JSON.parse(localStorage.getItem("gastos_groups") || "[]"); } catch { groups = []; }
    try { serverCfg = JSON.parse(localStorage.getItem("gastos_server") || "{}"); } catch { serverCfg = {}; }
    activeId = localStorage.getItem("gastos_active") || null;

    // Migrar datos de versión anterior (sin usuarios)
    const legacy = localStorage.getItem("gastos_app");
    if (legacy && users.length === 0) {
        const uid = "u_legacy";
        users = [{ id: uid, name: "Yo", telegramId: null }];
        activeId = uid;
        saveUsers();
        saveActive();
        localStorage.setItem("gastos_data_" + uid, legacy);
    }

    // Datos de demo si no hay nada
    if (users.length === 0) {
        const uid = "demo1";
        const now = new Date();
        const dKey = getKey(now.getMonth(), now.getFullYear());
        const prev = getKey(
            now.getMonth() === 0 ? 11 : now.getMonth() - 1,
            now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
        );
        users = [{ id: uid, name: "Demo", telegramId: null }];
        activeId = uid;
        saveUsers();
        saveActive();
        const demo = {};
        demo[dKey] = [
            { id: 1, desc: "Carrefour", amt: 28500, cat: "Alimentación", type: "Variable", date: `${now.getFullYear()}-04-02` },
            { id: 2, desc: "Alquiler", amt: 180000, cat: "Vivienda", type: "Fijo", date: `${now.getFullYear()}-04-01` },
            { id: 3, desc: "SUBE", amt: 12000, cat: "Transporte", type: "Variable", date: `${now.getFullYear()}-04-03` },
            { id: 4, desc: "Netflix", amt: 4200, cat: "Entretenimiento", type: "Fijo", date: `${now.getFullYear()}-04-01` },
            { id: 5, desc: "Farmacia", amt: 8900, cat: "Salud", type: "Variable", date: `${now.getFullYear()}-04-05` },
        ];
        demo[prev] = [
            { id: 10, desc: "Supermercado", amt: 31000, cat: "Alimentación", type: "Variable", date: `${now.getFullYear()}-03-03` },
            { id: 11, desc: "Alquiler", amt: 180000, cat: "Vivienda", type: "Fijo", date: `${now.getFullYear()}-03-01` },
            { id: 12, desc: "SUBE", amt: 9800, cat: "Transporte", type: "Variable", date: `${now.getFullYear()}-03-05` },
            { id: 13, desc: "Edesur", amt: 13200, cat: "Servicios", type: "Fijo", date: `${now.getFullYear()}-03-04` },
        ];
        saveUserData(uid, demo);
    }
}