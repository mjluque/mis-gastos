// ── Constantes compartidas ────────────────────────────────────────────────────

export const MONTHS = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export const CATEGORIES = [
    "Alimentación", "Transporte", "Vivienda", "Salud", "Entretenimiento",
    "Ropa", "Educación", "Servicios", "Restaurantes", "Otros",
];

export const CAT_COLORS = {
    "Alimentación": "#378ADD",
    "Transporte": "#1D9E75",
    "Vivienda": "#D85A30",
    "Salud": "#D4537E",
    "Entretenimiento": "#534AB7",
    "Ropa": "#BA7517",
    "Educación": "#639922",
    "Servicios": "#888780",
    "Restaurantes": "#185FA5",
    "Otros": "#3C3489",
};

// ── Helpers de formato ────────────────────────────────────────────────────────

export function fmt(n) {
    return "$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export function getKey(m, y) {
    return `${y}-${String(m).padStart(2, "0")}`;
}

export function curKey() {
    const msel = document.getElementById("month-select");
    const ysel = document.getElementById("year-select");
    return getKey(msel.value, ysel.value);
}