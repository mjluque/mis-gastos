# mis-gastos
Aplicación para el registro, seguimiento y análisis de gastos personales


# Bot de Telegram — Registro de gastos

## Pasos para activar el bot

### 1. Crear el bot en Telegram
1. Abrí Telegram y buscá **@BotFather**
2. Mandá `/newbot`
3. Poné un nombre (ej: "Mis Gastos") y un usuario (ej: `mis_gastos_bot`)
4. BotFather te da un **token** → guardalo, lo vas a necesitar


### 2. Obtener tu ID de Telegram (para seguridad)
1. Buscá **@userinfobot** en Telegram
2. Mandá cualquier mensaje
3. Te responde con tu ID numérico → guardalo

### 3. Deploy en Railway (gratis, recomendado)
1. Creá cuenta en https://railway.app
2. "New Project" → "Deploy from GitHub" (o subí los archivos)
3. Configurá las variables de entorno:
   - `BOT_TOKEN` → el token de BotFather
   - `WEBHOOK_URL` → la URL que te da Railway (ej: https://bot-gastos.up.railway.app)
   - `ALLOWED_IDS` → tu ID de Telegram (ej: 123456789)
4. Railway instala dependencias y arranca automáticamente

### 4. Alternativa: Render (también gratis)
- https://render.com → "New Web Service"
- Mismas variables de entorno que arriba

### 5. Usar el bot
Agregá el bot al grupo de WhatsApp... digo, **Telegram** que uses con tu familia/pareja, o usalo en privado.

**Comandos disponibles:**
```
gasto 2800 supermercado              → guarda $2800, categoría auto-detectada
gasto 15000 alquiler vivienda fijo   → $15000, Vivienda, tipo Fijo
gasto 5500 dentista salud            → $5500, Salud
/resumen                             → totales del mes por categoría
/lista                               → últimos 8 gastos
/ayuda                               → instrucciones
```

### 6. Conectar con la app web
La app web puede cargar los datos del servidor agregando este código en tu app:

```javascript
// Al iniciar la app, intentar cargar desde el servidor
async function syncFromServer() {
  try {
    const res = await fetch('https://TU-URL.railway.app/api/gastos');
    const serverData = await res.json();
    // Mergear con datos locales (el servidor es fuente de verdad)
    Object.assign(data, serverData);
    save();
    renderResumen();
  } catch(e) {
    console.log('Sin conexión al servidor, usando datos locales');
  }
}
syncFromServer();
```

## Estructura de datos (gastos.json)
```json
{
  "2026-03": [
    {
      "id": 1710000000000,
      "desc": "Supermercado",
      "amt": 2800,
      "cat": "Alimentación",
      "type": "Variable",
      "date": "2026-03-15"
    }
  ]
}
```

## Archivos del proyecto
```
bot-gastos/
├── bot.js         ← servidor principal
├── package.json   ← dependencias
├── gastos.json    ← datos (se crea automáticamente)
└── README.md      ← esta guía
```
