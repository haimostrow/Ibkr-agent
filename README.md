# Agente IBKR — Deploy en Railway

## Lo que hace este servidor
- Escanea tu watchlist cada 30 minutos (solo horario de mercado NY)
- Analiza con IA y detecta señales de 90%+ confianza
- Te manda WhatsApp automático con la señal completa
- Ejecuta la orden en IBKR si configuraste el Gateway (opcional)

---

## Paso a paso — Railway (15 minutos)

### 1. Sube el código a GitHub
1. Ve a github.com → New repository → nombre: `ibkr-agent`
2. Sube estos 3 archivos: `server.js`, `package.json`, `.env.example`

### 2. Crea proyecto en Railway
1. Ve a railway.app y crea cuenta gratuita
2. New Project → Deploy from GitHub repo
3. Selecciona tu repo `ibkr-agent`
4. Railway detecta automáticamente que es Node.js

### 3. Configura las variables de entorno
En Railway → tu proyecto → **Variables**, agrega una por una:

| Variable | Valor |
|----------|-------|
| ANTHROPIC_API_KEY | Tu API key de Anthropic |
| TWILIO_SID | ACb1660aad126ee179e447c850d70... |
| TWILIO_TOKEN | Tu auth token de Twilio |
| TWILIO_FROM | whatsapp:+14155238886 |
| TWILIO_TO | whatsapp:+50766713170 |
| MIN_CONFIDENCE | 90 |
| SCAN_INTERVAL_MIN | 30 |
| WATCHLIST | SPY,QQQ,NVDA,AAPL,MSFT,AMZN,META,TSLA,GOOGL,AMD,JPM,GLD |

### 4. Deploy
Railway hace el deploy automáticamente. En 2-3 minutos el servidor está activo.

### 5. Verifica que funciona
Railway te da una URL pública (ej: `https://ibkr-agent-production.up.railway.app`).
Ábrela en tu browser — debes ver el status del agente en JSON.

Para forzar un scan manual, visita: `tu-url/scan`

---

## Cómo obtener tu Anthropic API Key
1. Ve a console.anthropic.com
2. API Keys → Create Key
3. Copia la key (empieza con `sk-ant-...`)

---

## IBKR Gateway en Railway (ejecución automática)
Para que el agente ejecute órdenes solo, necesitas también correr el
IBKR Client Portal Gateway. Esto requiere un servidor separado con
autenticación manual cada 24 horas. Se recomienda empezar sin esto
y agregarlo después.

---

## Comandos útiles
- Ver logs: Railway → tu proyecto → Deployments → View Logs
- Forzar scan: GET `tu-url/scan`  
- Ver alertas enviadas: GET `tu-url/alerts`
- Ver último scan: GET `tu-url/`
