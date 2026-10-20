# jev-mail

Clasificador de correo con IA (Jev/typesafe.ai), memoria SQLite y panel local.

## Requisitos

- Node.js 24+ (usa `--experimental-sqlite`)
- Buzón IMAP con acceso (usa contraseña de aplicación si tu proveedor lo requiere)
- Clave API de [typesafe.ai](https://typesafe.ai)

## Instalación

```bash
npm install
cp .env.example .env
# editar .env con tus credenciales
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `IMAP_HOST` | Servidor IMAP (ej. `imap.gmail.com`) |
| `IMAP_PORT` | Puerto IMAP (default `993`) |
| `IMAP_USER` | Usuario del buzón |
| `IMAP_PASSWORD` | Contraseña o contraseña de aplicación |
| `IMAP_MAILBOX` | Carpeta a leer (default `INBOX`) |
| `TYPESAFE_API_KEY` | Clave de la API de typesafe.ai |
| `JEV_INPUT_USD_PER_1M` | Costo USD por 1M tokens de entrada (opcional) |
| `JEV_OUTPUT_USD_PER_1M` | Costo USD por 1M tokens de salida (opcional) |

## Comandos

```bash
# Descargar últimos 20 mensajes del buzón → emails.json
npm run fetch:emails

# Clasificar emails.json → results.json
npm run classify

# Panel local en http://127.0.0.1:3000
npm run dashboard

# Descubrimiento incremental (nuevos mensajes)
npm run ingest:new

# Recorrido del histórico por lotes
npm run ingest:history

# Verificación de tipos
npm run typecheck
```

## Flujo de trabajo

```
fetch:emails  →  classify  →  dashboard
   (IMAP)         (Jev)       (panel)
```

1. **`fetch:emails`** conecta IMAP en modo solo lectura, descarga el texto de los últimos 20 mensajes y los guarda en `emails.json`. Si falla la conexión o la descarga, `emails.json` no se modifica.
2. **`classify`** clasifica cada correo con Jev y guarda `results.json`. Un fallo en un correo no aborta el lote. Las decisiones se cachean en SQLite para evitar llamadas repetidas.
3. **`dashboard`** sirve un panel en loopback (`127.0.0.1:3000`). Muestra los resultados, permite corregir clasificaciones y crear reglas manuales.

## Clasificador base

Cada correo recibe del clasificador base:

- **category** — `Trabajo`, `Personal` o `Indeterminado`
- **spamProbability** — probabilidad de ser spam/phishing/publicidad
- **needsAttentionProbability** — probabilidad de requerir acción en 48 h

## Clasificadores configurables

Desde el panel puedes crear clasificadores adicionales de tipo `choice` (2-20 opciones) o `noul` (sí/no). Editar la semántica sube la versión e invalida la caché solo de ese clasificador.

## Reglas manuales

Cubren un remitente exacto o un dominio. Prioridad: EMAIL > DOMAIN > caché > Jev. Las reglas nunca se crean automáticamente — solo desde el panel.

## Ingesta incremental

- `ingest:new` descubre mensajes nuevos por UID y procesa los pendientes (DISCOVERED/FAILED).
- `ingest:history` recorre el buzón histórico en lotes de 50 (configurable con `--limit=N` o `INGEST_BATCH`). Un cambio de UIDVALIDITY inicia época nueva sin reutilizar datos anteriores.

## Archivos de datos

`emails.json`, `results.json` y `data/jev.sqlite` contienen datos reales del buzón y están en `.gitignore`. No se suben al repositorio.

## Documentación

| Archivo | Descripción |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Diseño interno y flujo de datos |
| [docs/dashboard.md](docs/dashboard.md) | Uso del panel local |
| [docs/ingestion.md](docs/ingestion.md) | Ingesta incremental (new / history) |
| [docs/api-reference.md](docs/api-reference.md) | Endpoints HTTP del panel |
| [docs/sqlite-schema.md](docs/sqlite-schema.md) | Esquema de la base SQLite |
