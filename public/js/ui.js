// ── ui.js — funciones de UI compartidas ──────────────────────────────────────

import { activeUser } from "./storage.js";

// ── Toast ─────────────────────────────────────────────────────────────────────

export function toast(msg, ok = true) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2500);
}

// ── Indicador de sincronización ───────────────────────────────────────────────

export function setSyncStatus(state, text) {
    const el = document.getElementById("sync-status");
    const dots = {
        idle: "",
        syncing: '<span class="spinning">↻</span>',
        ok: '<span style="color:#1D9E75">●</span>',
        err: '<span style="color:#D85A30">●</span>',
    };
    el.innerHTML = `${dots[state] || ""} <span>${text}</span>`;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function updateHeader() {
    const u = activeUser();
    document.getElementById("avatar").textContent = u ? u.name.charAt(0).toUpperCase() : "?";
    document.getElementById("user-name").textContent = u ? u.name : "Sin usuario";
}