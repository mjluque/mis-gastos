# Bot de gastos v3 — Guía de instalación completa

## Estructura del proyecto
```
bot-gastos-v3/
├── bot.js              ← servidor (bot + API + web)
├── package.json
├── public/
│   └── index.html      ← app web (servida en /)
└── data/
    └── user_*.json     ← datos por usuario (se crea automáticamente)
```

---

## Paso 1 — Configurar Google Sheets

### 1.1 Crear el Google Sheet
1. Creá un nuevo Google Sheet en https://sheets.google.com
2. Copiá el ID de la URL: `https://docs.google.com/spreadsheets/d/1OLb3LI_T5qU_y2FjeRNz91bMC4QrpXwsXUuOq8_Cnck/edit`

### 1.2 Crear cuenta de servicio en Google Cloud
1. Entrá a https://console.cloud.google.com
2. Creá un proyecto nuevo (o usá uno existente)
3. Buscá "Google Sheets API" → habilitarla
4. Ir a "IAM y administración" → "Cuentas de servicio" → "Crear cuenta de servicio"
   - Nombre: `bot-gastos`
   - Rol: no es necesario asignar rol de proyecto
5. Abrí la cuenta de servicio → pestaña "Claves" → "Agregar clave" → JSON
6. Se descarga un archivo `.json` con las credenciales

### 1.3 Compartir el Sheet con la cuenta de servicio
1. Abrí el `.json` descargado y copiá el campo `client_email`
   (algo como `bot-gastos@mi-proyecto.iam.gserviceaccount.com`)
2. En tu Google Sheet → "Compartir" → pegá ese email → darle permiso de **Editor**

### 1.4 Preparar las credenciales para Railway
El JSON de credenciales tiene que ir en una sola línea como variable de entorno.
En terminal (Linux/Mac):
```bash
cat credenciales.json | tr -d '\n'
```
Copiá el resultado completo para usarlo en el paso 2.

---

## Paso 2 — Deploy en Railway

1. Creá cuenta en https://railway.app
2. "New Project" → "Deploy from GitHub" (subí el proyecto a GitHub primero)
   O bien: "New Project" → "Empty project" → "Add Service" → "GitHub Repo"
3. Configurá las variables de entorno en Railway:

| Variable             | Valor                                          |
|----------------------|------------------------------------------------|
| `BOT_TOKEN`          | Token de @BotFather                            |
| `WEBHOOK_URL`        | URL que te da Railway (ej: https://xxx.up.railway.app) |
| `API_SECRET`         | Cualquier string largo que vos elijas          |
| `ALLOWED_IDS`        | IDs de Telegram separados por coma             |
| `GOOGLE_SHEET_ID`    | ID del Sheet (del paso 1.2)                    |
| `GOOGLE_CREDENTIALS` | JSON en una línea (del paso 1.4)               |

4. Railway instala dependencias y arranca automáticamente.
5. La app web queda disponible en `https://tu-url.railway.app`

---

## Paso 3 — Configurar la app web

1. Abrí `https://tu-url.railway.app` en el navegador
2. Ir a ⚙ Config
3. Completar:
   - **URL del servidor**: la misma URL de Railway
   - **API Secret**: el mismo que pusiste en Railway
   - Activar "Sincronizar automáticamente al abrir"
4. Agregar cada usuario con su nombre y ID de Telegram
5. El badge "📊 Sheets activo" aparece si la conexión con Sheets está funcionando

---

## Estructura del Google Sheet

El servidor crea automáticamente dos hojas:

### Hoja "Gastos" (fila por gasto)
| ID | Usuario | Fecha | Descripción | Monto | Categoría | Tipo | Mes | Año |
|----|---------|-------|-------------|-------|-----------|------|-----|-----|
| 1710000001 | María | 2026-04-02 | Supermercado | 2800 | Alimentación | Variable | Abril | 2026 |

### Hoja "Resumen_Mensual" (agregado por usuario/mes/categoría)
| Usuario | Año | Mes | Categoría | Total |
|---------|-----|-----|-----------|-------|
| María | 2026 | Abril | Alimentación | 45300 |

Con esta estructura podés armar en el mismo Sheet:
- **Tablas dinámicas** por usuario, mes, categoría
- **Gráficos** de evolución mensual
- **Comparativas** entre usuarios del hogar

---

## Uso del bot

```
gasto 2800 supermercado              → guarda y registra en Sheets
gasto 15000 alquiler vivienda fijo   → tipo Fijo
gasto 5500 dentista salud            → categoría auto-detectada
/resumen                             → totales del mes
/lista                               → últimos 8 gastos
/ayuda                               → instrucciones + tu ID de Telegram
```

---

## Troubleshooting

**El bot no responde**
→ Verificar `BOT_TOKEN` y `WEBHOOK_URL` en Railway
→ Chequear logs en Railway → "Deployments" → "View logs"

**No escribe en Sheets**
→ Verificar que compartiste el Sheet con el `client_email` de la cuenta de servicio
→ Verificar que la API de Sheets esté habilitada en Google Cloud
→ Asegurarse que `GOOGLE_CREDENTIALS` es el JSON completo en una sola línea

**La app web no sincroniza**
→ Verificar que `API_SECRET` coincide entre Railway y la app
→ Probar `https://tu-url.railway.app/api/health` — debe devolver `{"ok":true,...}`
