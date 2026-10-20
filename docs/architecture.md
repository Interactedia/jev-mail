# Arquitectura

## Visión general

jev-mail se compone de tres fases discretas conectadas por archivos JSON y una base SQLite:

```
IMAP (imap.ts)
    ↓  emails.json
Jev  (jev.ts + classify.ts)
    ↓  results.json + SQLite
Dashboard  (dashboard.ts)
```

El proceso es **aditivo y sin estado**: cada fase lee sus entradas y produce sus salidas; no hay estado global entre ejecuciones, excepto SQLite para la caché.

## Fases

### 1. Fetch (IMAP → emails.json)

`imap.ts` conecta IMAP con `getMailboxLock(..., { readOnly: true })` para todo el flujo. Solo descarga la parte MIME `text/plain` (o `text/html` como fallback), con un máximo de 10 000 caracteres. Nunca descarga adjuntos. Los flags se verifican antes y después; si cambian se reporta error y se sale con código 1.

Salida: `emails.json` — array de objetos con `id`, `uid`, `uidValidity`, `messageId`, `from`, `subject`, `date`, `body`.

### 2. Clasificación (emails.json → results.json + SQLite)

`classify.ts` reusa `classifyEmails()` exportable, llamada también por `ingest.ts`.

**Resolución por clasificador:**

```
regla EMAIL → regla DOMAIN → caché (mismo criteria) → Jev
```

- Las reglas son manuales, nunca automáticas.
- La caché es por `(classifier_id, email_id, criteria)`. Cambiar la semántica de un clasificador modifica su `criteria` → invalida solo su propia caché.
- `CRITERIA_VERSION` en `memory.ts` invalida toda la caché del clasificador base.

**Petición Jev:**

`POST https://api.typesafe.ai/v1/systemone` con una petición conjunta por correo: preguntas del clasificador base + una pregunta por cada clasificador configurable activo. Los nombres de pregunta se responden tal cual se envían, lo que permite clasificadores con nombres propios.

### 3. Panel (results.json + SQLite → HTML)

`dashboard.ts` sirve un servidor HTTP en `127.0.0.1:3000` con las rutas:

| Ruta | Método | Descripción |
|---|---|---|
| `/` | GET | Panel HTML |
| `/api/data` | GET | Datos cargados (results + emails) |
| `/api/reviews` | POST | Guardar evaluación |
| `/api/rules` | POST | Crear regla |
| `/api/rules/toggle` | POST | Habilitar/deshabilitar regla |
| `/api/classifiers` | POST | Crear clasificador |
| `/api/classifiers/update` | POST | Editar clasificador |
| `/api/classifiers/toggle` | POST | Habilitar/deshabilitar clasificador |

Solo sirve loopback; no tiene archivos estáticos ni rutas de sistema de archivos.

## Esquema SQLite (v3)

Ubicación: `data/jev.sqlite` (gitignored).

```sql
-- Metadatos de esquema
meta (key TEXT PK, value TEXT)

-- Clasificadores configurables (el base es id='base', no editable)
classifiers (
  id, name, description, question, type, options JSON,
  enabled, version, criteria, created_at, updated_at
)

-- Reglas manuales: EMAIL = dirección exacta, DOMAIN = dominio exacto
rules (
  id, classifier_id, type, value, action, origin, enabled, created_at,
  UNIQUE(classifier_id, type, value)
)

-- Caché de decisiones por clasificador
classifications (
  classifier_id, email_id, sender, domain, classification,
  probability, source, criteria, model, detail JSON,
  created_at, PRIMARY KEY(classifier_id, email_id, criteria)
)

-- Ingesta: estado por mensaje descubierto
ingest_messages (
  id, account_id, mailbox, uid_validity, uid, message_id,
  status DISCOVERED|FETCHED|FAILED,
  discovered_at, fetched_at, failed_at, last_error, attempts,
  UNIQUE(account_id, mailbox, uid_validity, uid)
)

-- Cursores: marca UID máxima procesada
ingest_cursors (
  account_id, mailbox, uid_validity,
  new_cursor, history_cursor, updated_at,
  PK(account_id, mailbox, uid_validity)
)
```

## Ingesta incremental (esquema v3)

- **Descubrimiento** por UID: `SEARCH {uid}` en el servidor IMAP. Los UIDs descubiertos se insertan con `INSERT OR IGNORE` (idempotente).
- **Cursor**: avanza solo después de persistir los mensajes descubiertos. Si el proceso falla antes de avanzar, se reintenta en la siguiente ejecución.
- **Época**: cada `UIDVALIDITY` nuevo crea una época independiente. Los cursores y pendientes de épocas anteriores no se reutilizan.
- **Procesamiento de pendientes**: `DISCOVERED` (no descargado) o `FAILED` (falló antes, recuperable). `FETCHED` se omite.
- **Límite de intentos**: `attempts++` por cada intento; no hay límite fijo pero sí registro de errores.

## Degradación

Si SQLite falla, `memory.ts` degrada silenciosamente y siempre consulta a Jev. Las reglas y caché nunca se inventan; la BD corrupta solo incrementa el costo en llamadas.
