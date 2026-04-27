// ── renders.js — funciones de renderizado del DOM ────────────────────────────

import { MONTHS, CAT_COLORS, CATEGORIES, fmt, curKey } from "./config.js";
import { users, groups, activeId, serverCfg, activeUser, curData, curExpenses, loadGroupData, saveGroupData } from "./storage.js";
import { setSyncStatus } from "./ui.js";
import { syncUserManual, fetchGroupData, saveServerConfig, checkServerHealth } from "./api.js";
import { openEditFromBtn } from "./modals.js";

// Estado local de Charts y comparación
let pieChart     = null;
let compareChart = null;
export let selectedMonths = [];
export function setSelectedMonths(arr) { selectedMonths = arr; }

// ── Resumen personal ──────────────────────────────────────────────────────────

export function renderResumen(currentView, activeGroupId) {
  if (currentView === "group") return renderResumenGrupal(activeGroupId);

  const key  = curKey();
  const exps = curExpenses(key);
  const total = exps.reduce((s, e) => s + e.amt, 0);
  const fijos = exps.filter((e) => e.type === "Fijo").reduce((s, e) => s + e.amt, 0);
  const vars  = exps.filter((e) => e.type === "Variable").reduce((s, e) => s + e.amt, 0);

  document.getElementById("metrics-row").innerHTML = `
    <div class="metric"><div class="metric-label">Total del mes</div><div class="metric-value">${fmt(total)}</div></div>
    <div class="metric"><div class="metric-label">Fijos</div><div class="metric-value">${fmt(fijos)}</div></div>
    <div class="metric"><div class="metric-label">Variables</div><div class="metric-value">${fmt(vars)}</div></div>
    <div class="metric"><div class="metric-label">Registros</div><div class="metric-value">${exps.length}</div></div>`;

  const byCat = {};
  exps.forEach((e) => { byCat[e.cat] = (byCat[e.cat] || 0) + e.amt; });
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max    = sorted[0] ? sorted[0][1] : 1;

  document.getElementById("cat-bars").innerHTML = sorted.length
    ? sorted.map(([cat, amt]) => `
        <div class="bar-row">
          <div class="bar-label">${cat}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(amt / max * 100).toFixed(1)}%;background:${CAT_COLORS[cat] || "#888"}"></div></div>
          <div class="bar-val">${fmt(amt)}</div>
        </div>`).join("")
    : '<div class="empty">Sin gastos este mes</div>';

  if (pieChart) pieChart.destroy();
  if (sorted.length) {
    pieChart = new Chart(document.getElementById("pie-chart"), {
      type: "doughnut",
      data: {
        labels: sorted.map((x) => x[0]),
        datasets: [{ data: sorted.map((x) => x[1]), backgroundColor: sorted.map((x) => CAT_COLORS[x[0]] || "#888"), borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.raw)}` } } } },
    });
    document.getElementById("pie-legend").innerHTML = sorted.map(([cat, amt]) => `
      <div class="legend-item">
        <div class="legend-sq" style="background:${CAT_COLORS[cat] || "#888"}"></div>
        ${cat} ${total > 0 ? "(" + ((amt / total) * 100).toFixed(0) + "%)" : ""}
      </div>`).join("");
  }

  const recent = [...exps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  document.getElementById("recent-list").innerHTML = recent.length
    ? recent.map((e) => `
        <div class="expense-row">
          <div class="cat-dot" style="background:${CAT_COLORS[e.cat] || "#888"}"></div>
          <div class="expense-desc">${e.desc}<div class="expense-sub">${e.cat} · ${e.type} · ${e.date}</div></div>
          <div class="expense-amt">${fmt(e.amt)}</div>
        </div>`).join("")
    : '<div class="empty">Agregá tu primer gasto del mes</div>';
}

// ── Resumen grupal ────────────────────────────────────────────────────────────

export async function renderResumenGrupal(activeGroupId) {
  const g = groups.find((x) => x.id === activeGroupId);
  if (!g) {
    document.getElementById("metrics-row").innerHTML = '<div style="color:var(--text2);font-size:13px">Configurá el grupo en ⚙ Config.</div>';
    return;
  }

  setSyncStatus("syncing", "Cargando grupo...");
  const serverData = await fetchGroupData(activeGroupId);
  const time = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  setSyncStatus(serverData ? "ok" : "err", serverData ? `${g.name} · ${time}` : "Sin conexión al servidor");

  const data = loadGroupData(activeGroupId);
  const key  = curKey();
  const exps = data[key] || [];

  const total    = exps.reduce((s, e) => s + e.amt, 0);
  const byPerson = {};
  exps.forEach((e) => {
    const n = e.user_name || "Sin nombre";
    if (!byPerson[n]) byPerson[n] = 0;
    byPerson[n] += e.amt;
  });
  const personas = Object.keys(byPerson).length;

  document.getElementById("metrics-row").innerHTML = `
    <div class="metric"><div class="metric-label">Total grupal</div><div class="metric-value">${fmt(total)}</div></div>
    <div class="metric"><div class="metric-label">Personas</div><div class="metric-value">${personas}</div></div>
    <div class="metric"><div class="metric-label">Registros</div><div class="metric-value">${exps.length}</div></div>
    <div class="metric"><div class="metric-label">Promedio</div><div class="metric-value">${personas ? fmt(Math.round(total / personas)) : "—"}</div></div>`;

  const maxP = Math.max(...Object.values(byPerson), 1);
  document.getElementById("cat-bars").innerHTML = Object.entries(byPerson)
    .sort((a, b) => b[1] - a[1])
    .map(([name, amt]) => `
      <div class="bar-row">
        <div class="bar-label" style="width:96px">${name.split(" ")[0]}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(amt / maxP * 100).toFixed(1)}%;background:var(--blue)"></div></div>
        <div class="bar-val">${fmt(amt)}</div>
      </div>`).join("");

  const recent = [...exps].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  document.getElementById("recent-list").innerHTML = recent.length
    ? recent.map((e) => `
        <div class="expense-row">
          <div class="cat-dot" style="background:${CAT_COLORS[e.cat] || "#888"}"></div>
          <div class="expense-desc">${e.desc}<div class="expense-sub">${e.user_name || ""} · ${e.cat} · ${e.date}</div></div>
          <div class="expense-amt">${fmt(e.amt)}</div>
        </div>`).join("")
    : '<div class="empty">Sin gastos grupales este mes</div>';
}

// ── Lista de gastos ───────────────────────────────────────────────────────────

export function renderList() {
  const key    = curKey();
  const exps   = curExpenses(key);
  const fcat   = document.getElementById("filter-cat").value;
  const ftype  = document.getElementById("filter-type").value;
  const sort   = document.getElementById("sort-by").value;

  let filtered = exps.filter((e) => (!fcat || e.cat === fcat) && (!ftype || e.type === ftype));
  if (sort === "amt-desc") filtered.sort((a, b) => b.amt - a.amt);
  else if (sort === "amt-asc") filtered.sort((a, b) => a.amt - b.amt);
  else filtered.sort((a, b) => b.date.localeCompare(a.date));

  document.getElementById("expense-list").innerHTML = filtered.length
    ? filtered.map((e) => `
        <div class="expense-row">
          <div class="cat-dot" style="background:${CAT_COLORS[e.cat] || "#888"}"></div>
          <div class="expense-desc">${e.desc}<div class="expense-sub">${e.cat} · ${e.type} · ${e.date}</div></div>
          <div class="expense-amt">${fmt(e.amt)}</div>
          <button class="btn btn-sm btn-edit"
            data-id="${e.id}"
            data-desc="${(e.desc || "").replace(/"/g, "&quot;")}"
            data-amt="${e.amt}"
            data-cat="${e.cat}"
            data-type="${e.type}"
            data-date="${e.date}"
            onclick="window.__openEditFromBtn(this)">✏</button>
          <button class="btn btn-sm btn-danger" onclick="window.__deleteExpense(${e.id})">×</button>
        </div>`).join("")
    : '<div class="empty">Sin gastos con ese filtro</div>';

  const total = filtered.reduce((s, e) => s + e.amt, 0);
  document.getElementById("list-total").textContent = filtered.length ? `Total: ${fmt(total)}` : "";
}

// ── Comparar ──────────────────────────────────────────────────────────────────

export function renderCompare() {
  const data    = curData();
  const allKeys = Object.keys(data).filter((k) => (data[k] || []).length > 0).sort();

  document.getElementById("month-pills").innerHTML = allKeys.length
    ? allKeys.map((k) => {
        const [y, m] = k.split("-");
        return `<button class="pill ${selectedMonths.includes(k) ? "active" : ""}" onclick="window.__toggleMonth('${k}')">${MONTHS[parseInt(m)].substring(0, 3)} ${y}</button>`;
      }).join("")
    : '<div style="font-size:12px;color:var(--text3)">Sin datos aún</div>';

  if (!allKeys.length) return;
  if (!selectedMonths.length) {
    selectedMonths = allKeys.slice(-Math.min(3, allKeys.length));
    renderCompare();
    return;
  }

  const labels = selectedMonths.map((k) => { const [y, m] = k.split("-"); return `${MONTHS[parseInt(m)].substring(0, 3)} ${y}`; });
  const totals = selectedMonths.map((k) => (data[k] || []).reduce((s, e) => s + e.amt, 0));

  if (compareChart) compareChart.destroy();
  compareChart = new Chart(document.getElementById("compare-chart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Total", data: totals, backgroundColor: ["#378ADD","#1D9E75","#D85A30","#534AB7","#BA7517"].slice(0, selectedMonths.length), borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "rgba(128,128,128,0.08)" } }, x: { grid: { display: false } } } },
  });

  const rows = Object.keys(CAT_COLORS).map((cat) => {
    const vals = selectedMonths.map((k) => (data[k] || []).filter((e) => e.cat === cat).reduce((s, e) => s + e.amt, 0));
    return vals.every((v) => v === 0) ? null : { cat, vals };
  }).filter(Boolean);

  document.getElementById("cat-compare-table").innerHTML = rows.length
    ? `<table style="width:100%;font-size:12px;border-collapse:collapse">
        <thead><tr style="color:var(--text2)">
          <th style="text-align:left;padding:4px 0;font-weight:400">Categoría</th>
          ${labels.map((l) => `<th style="text-align:right;padding:4px 6px;font-weight:400">${l}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr style="border-top:0.5px solid var(--border)">
              <td style="padding:5px 0;display:flex;align-items:center;gap:5px">
                <span style="width:7px;height:7px;border-radius:50%;background:${CAT_COLORS[r.cat]};flex-shrink:0;display:inline-block"></span>${r.cat}
              </td>
              ${r.vals.map((v, i) => {
                const d = i > 0 && r.vals[i-1] > 0 ? ((v - r.vals[i-1]) / r.vals[i-1] * 100) : null;
                return `<td style="text-align:right;padding:5px 6px">${v > 0 ? fmt(v) : "—"}${d !== null && v > 0 ? `<span class="${d > 0 ? "delta-neg" : "delta-pos"}"> ${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(0)}%</span>` : ""}</td>`;
              }).join("")}
            </tr>`).join("")}
          <tr style="border-top:1px solid var(--border2);font-weight:500">
            <td style="padding:6px 0">Total</td>
            ${totals.map((v, i) => {
              const d = i > 0 && totals[i-1] > 0 ? ((v - totals[i-1]) / totals[i-1] * 100) : null;
              return `<td style="text-align:right;padding:6px 6px">${fmt(v)}${d !== null ? `<span class="${d > 0 ? "delta-neg" : "delta-pos"}"> ${d > 0 ? "▲" : "▼"}${Math.abs(d).toFixed(0)}%</span>` : ""}</td>`;
            }).join("")}
          </tr>
        </tbody>
      </table>`
    : '<div class="empty">Seleccioná meses para comparar</div>';
}

// ── Config ────────────────────────────────────────────────────────────────────

export function renderConfig() {
  document.getElementById("user-list").innerHTML = users.length
    ? users.map((u) => `
        <div class="user-row">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="avatar" style="width:28px;height:28px;font-size:12px">${u.name.charAt(0).toUpperCase()}</div>
            <div>
              <div style="font-size:13px;font-weight:${activeId === u.id ? 500 : 400}">${u.name}${activeId === u.id ? ' <span style="font-size:10px;color:#1D9E75">● activo</span>' : ""}</div>
              <div style="font-size:11px;color:var(--text2)">ID: ${u.telegramId || "sin Telegram"}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" onclick="window.__syncUserManual('${u.id}')" style="color:var(--blue);border-color:var(--blue)">↓ Sync</button>
            <button class="btn btn-sm btn-danger" onclick="window.__deleteUser('${u.id}')">×</button>
          </div>
        </div>`).join("")
    : '<div class="empty" style="padding:16px">Sin usuarios. Agregá uno abajo.</div>';

  document.getElementById("active-user-picker").innerHTML = users.map((u) => `
    <button class="pill ${activeId === u.id ? "active" : ""}" onclick="window.__setActiveUser('${u.id}')">${u.name}</button>`).join("");

  const urlEl    = document.getElementById("server-url");
  const secretEl = document.getElementById("server-secret");
  const syncEl   = document.getElementById("auto-sync");
  if (serverCfg.url)    urlEl.value    = serverCfg.url;
  if (serverCfg.secret) secretEl.value = serverCfg.secret;
  syncEl.checked = !!serverCfg.autoSync;

  document.getElementById("group-list").innerHTML = groups.length
    ? groups.map((g) => `
        <div class="user-row">
          <div>
            <div style="font-size:13px;font-weight:500">👥 ${g.name}</div>
            <div style="font-size:11px;color:var(--text2)">ID: ${g.telegramId}</div>
          </div>
          <button class="btn btn-sm btn-danger" onclick="window.__deleteGroup('${g.id}')">×</button>
        </div>`).join("")
    : '<div class="empty" style="padding:12px">Sin grupos. Agregá uno abajo.</div>';
}
