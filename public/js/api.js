// ── api.js — comunicación con el servidor ────────────────────────────────────

import { serverCfg, saveServerCfg, users, groups, loadUserData, saveUserData, saveGroupData } from "./storage.js";
import { setSyncStatus, toast } from "./ui.js";
import { refresh } from "./app.js";

// ── Sincronización de usuario individual ─────────────────────────────────────

export async function syncUser(uid, silent = false) {
    const u = users.find((x) => x.id === uid);
    if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return false;
    try {
        const res = await fetch(
            `${serverCfg.url}/api/gastos?userId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
        );
        if (!res.ok) throw new Error("Error " + res.status);
        const serverData = await res.json();
        const local = loadUserData(uid);
        const merged = { ...local };
        Object.entries(serverData).forEach(([k, v]) => {
            if (!merged[k] || v.length >= merged[k].length) merged[k] = v;
        });
        saveUserData(uid, merged);
        return true;
    } catch (e) {
        if (!silent) console.warn("Sync user:", e.message);
        return false;
    }
}

// ── Sincronización de todos los usuarios ──────────────────────────────────────

export async function syncNow(auto = false) {
    const withTg = users.filter((u) => u.telegramId);
    if (!serverCfg.url || !serverCfg.secret || !withTg.length) {
        if (!auto) { setSyncStatus("err", "Sin servidor configurado"); toast("Configurá el servidor en ⚙ Config", false); }
        return;
    }
    setSyncStatus("syncing", "Sincronizando...");
    let ok = 0;
    for (const u of withTg) { if (await syncUser(u.id, true)) ok++; }
    const time = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    if (ok > 0) { setSyncStatus("ok", `Actualizado ${time}`); if (!auto) toast("✓ Sincronizado"); }
    else { setSyncStatus("err", `Sin conexión · ${time}`); if (!auto) toast("Sin conexión al servidor", false); }
    refresh();
}

// ── Sincronización manual de un usuario ──────────────────────────────────────

export async function syncUserManual(uid) {
    setSyncStatus("syncing", "Sincronizando...");
    const ok = await syncUser(uid, false);
    const time = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    setSyncStatus(ok ? "ok" : "err", ok ? `Actualizado ${time}` : `Sin conexión · ${time}`);
    toast(ok ? "✓ Sincronizado" : "Sin conexión al servidor", ok);
    if (ok) refresh();
}

// ── Carga de datos grupales ───────────────────────────────────────────────────

export async function fetchGroupData(groupId) {
    const g = groups.find((x) => x.id === groupId);
    if (!g || !serverCfg.url || !serverCfg.secret) return null;
    try {
        const res = await fetch(
            `${serverCfg.url}/api/gastos/grupo/${g.telegramId}?secret=${encodeURIComponent(serverCfg.secret)}`
        );
        if (!res.ok) return null;
        const data = await res.json();
        saveGroupData(groupId, data);
        return data;
    } catch { return null; }
}

// ── Editar gasto en servidor ──────────────────────────────────────────────────

export async function updateExpenseRemote(expenseId, fields) {
    const { activeUser } = await import("./storage.js");
    const u = activeUser();
    if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return;
    try {
        await fetch(
            `${serverCfg.url}/api/gastos/${expenseId}?userId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) }
        );
    } catch (e) { console.warn("Error actualizando en servidor:", e.message); }
}

// ── Eliminar gasto en servidor ────────────────────────────────────────────────

export async function deleteExpenseRemote(expenseId) {
    const { activeUser } = await import("./storage.js");
    const u = activeUser();
    if (!u?.telegramId || !serverCfg.url || !serverCfg.secret) return;
    try {
        await fetch(
            `${serverCfg.url}/api/gastos/${expenseId}?userId=${u.telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
            { method: "DELETE" }
        );
    } catch (e) { console.warn("Error eliminando en servidor:", e.message); }
}

// ── Info pública del servidor (no requiere secret) ────────────────────────────

export async function fetchServerInfo(serverUrl) {
    try {
        const res = await fetch(`${serverUrl}/api/info`);
        if (!res.ok) return null;
        return await res.json(); // { serverUrl }
    } catch { return null; }
}

// ── Configuración remota (clave: telegramId del usuario activo) ───────────────

export async function fetchRemoteConfig(telegramId) {
    if (!serverCfg.url || !serverCfg.secret || !telegramId) return null;
    try {
        const res = await fetch(
            `${serverCfg.url}/api/config?telegramId=${telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`
        );
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export async function pushRemoteConfig(telegramId, config) {
    if (!serverCfg.url || !serverCfg.secret || !telegramId) return;
    try {
        await fetch(
            `${serverCfg.url}/api/config?telegramId=${telegramId}&secret=${encodeURIComponent(serverCfg.secret)}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }
        );
    } catch (e) { console.warn("Error guardando config remota:", e.message); }
}

// ── Health check del servidor ─────────────────────────────────────────────────

export async function checkServerHealth() {
    if (!serverCfg.url) return;
    try {
        const res = await fetch(`${serverCfg.url}/api/health`);
        const json = await res.json();
        const badge = document.getElementById("sheets-badge");
        if (badge) badge.style.display = json.sheets ? "inline" : "none";
    } catch { /* sin conexión, no hacer nada */ }
}

// ── Guardar configuración del servidor ────────────────────────────────────────

export function saveServerConfig() {
    serverCfg.url = document.getElementById("server-url").value.trim();
    serverCfg.secret = document.getElementById("server-secret").value.trim();
    serverCfg.autoSync = document.getElementById("auto-sync").checked;
    saveServerCfg();
    toast("✓ Configuración guardada");
    checkServerHealth();
}