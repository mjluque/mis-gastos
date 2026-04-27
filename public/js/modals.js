// ── modals.js — modal de edición de gastos ───────────────────────────────────

import { curData, saveUserData, activeId, activeUser } from "./storage.js";
import { updateExpenseRemote } from "./api.js";
import { toast } from "./ui.js";

// ── Abrir modal ───────────────────────────────────────────────────────────────

export function openEditFromBtn(btn) {
  openEditModal(
    parseInt(btn.dataset.id),
    btn.dataset.desc,
    parseFloat(btn.dataset.amt),
    btn.dataset.cat,
    btn.dataset.type,
    btn.dataset.date
  );
}

export function openEditModal(id, desc, amt, cat, type, date) {
  document.getElementById("edit-id").value   = id;
  document.getElementById("edit-desc").value = desc;
  document.getElementById("edit-amt").value  = amt;
  document.getElementById("edit-cat").value  = cat;
  document.getElementById("edit-type").value = type;
  document.getElementById("edit-date").value = date;
  document.getElementById("edit-modal").classList.add("open");
}

// ── Cerrar modal ──────────────────────────────────────────────────────────────

export function closeEditModal(e) {
  // Cerrar solo si se hizo click en el backdrop (no en el modal en sí)
  if (e && e.target !== document.getElementById("edit-modal")) return;
  document.getElementById("edit-modal").classList.remove("open");
}

// ── Guardar edición ───────────────────────────────────────────────────────────

export async function saveEdit() {
  const id   = parseInt(document.getElementById("edit-id").value);
  const desc = document.getElementById("edit-desc").value.trim();
  const amt  = parseFloat(document.getElementById("edit-amt").value);
  const cat  = document.getElementById("edit-cat").value;
  const type = document.getElementById("edit-type").value;
  const date = document.getElementById("edit-date").value;

  if (!desc || !amt || !date) { toast("Completá todos los campos", false); return; }

  // Actualizar en localStorage (mover entre meses si la fecha cambió)
  const data = curData();
  for (const key of Object.keys(data)) {
    const idx = data[key].findIndex((e) => String(e.id) === String(id));
    if (idx >= 0) {
      const [ny, nm] = date.split("-");
      const newJsMonth = parseInt(nm) - 1;
      const newKey     = `${ny}-${String(newJsMonth).padStart(2, "0")}`;
      data[key][idx]   = { ...data[key][idx], desc, amt, cat, type, date };
      if (newKey !== key) {
        if (!data[newKey]) data[newKey] = [];
        data[newKey].push(data[key][idx]);
        data[key].splice(idx, 1);
      }
      break;
    }
  }
  saveUserData(activeId, data);

  // Actualizar en servidor en background
  await updateExpenseRemote(id, { desc, amt, cat, type, date });

  document.getElementById("edit-modal").classList.remove("open");
  toast("✓ Gasto actualizado");
  if (window.__refresh) window.__refresh();
}
