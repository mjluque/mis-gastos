// ── Constantes compartidas ────────────────────────────────────────────────────

export const MONTHS = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export const CATEGORIES = [
    "Comida",
    "Saliditas & Bares",
    "Vivienda",
    "Auto",
    "Mascotas",
    "Salud & Bienestar",
    "Transporte",
    "Gastos personales",
    "Subscripciones",
    "Viajes",
    "Donaciones",
    "Inversiones",
    "Otros",
];

export const CAT_COLORS = {
    "Comida":             "#378ADD",
    "Saliditas & Bares":  "#185FA5",
    "Vivienda":           "#D85A30",
    "Auto":               "#BA7517",
    "Mascotas":           "#639922",
    "Salud & Bienestar":  "#D4537E",
    "Transporte":         "#1D9E75",
    "Gastos personales":  "#888780",
    "Subscripciones":     "#534AB7",
    "Viajes":             "#0E9AA7",
    "Donaciones":         "#E87D3E",
    "Inversiones":        "#2E7D32",
    "Otros":              "#3C3489",
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