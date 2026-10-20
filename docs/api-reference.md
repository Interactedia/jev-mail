# Referencia de la API del panel

Base: `http://127.0.0.1:3000` (solo loopback). Todas las respuestas son JSON.

---

## GET /api/data

Devuelve los datos cargados actualmente.

**Respuesta 200:**
```json
{
  "results": [{ "id": "...", "subject": "...", "status": "ok", "classification": {...}, "classifiers": [...] }],
  "emails": [{ "id": "...", "from": "...", "subject": "...", "body": "..." }],
  "summary": {
    "total": 20,
    "ok": 19,
    "errors": 1,
    "jevCalls": 18,
    "avoidedCalls": 2,
    "bySource": { "JEV": 18, "RULE": 1, "CACHE": 1 },
    "durationMs": 4200,
    "inputTokens": 32000,
    "outputTokens": 1800
  },
  "cost": { "input": 0.064, "output": 0.018, "total": 0.082 }
}
```

---

## POST /api/reviews

Guardar evaluación de un correo.

**Body:**
```json
{
  "key": "yoab@gmail.com|INBOX|1234|567",
  "verdict": "correct",
  "correction": "Personal"
}
```

`verdict` — `"correct"` | `"incorrect"` | `"unevaluated"`
`correction` — opcional, nueva categoría cuando `"incorrect"`

**Respuesta 200:**
```json
{ "ok": true, "saved": { "key": "...", "verdict": "...", "origin": "JEV", "correction": null } }
```

---

## POST /api/rules

Crear o actualizar una regla manual.

**Body:**
```json
{
  "classifierId": "base",
  "type": "EMAIL",
  "value": "newsletter@amazon.com",
  "action": "PUBLICIDAD"
}
```

`type` — `"EMAIL"` | `"DOMAIN"`
`action` — para `base`: `"PUBLICIDAD"` | `"MANTENER"`; para `choice`: una de las opciones; para `noul`: `"sí"` | `"no"`

**Respuesta 200:**
```json
{ "ok": true, "rule": { "id": 5, "classifier_id": "base", "type": "EMAIL", "value": "newsletter@amazon.com", "action": "PUBLICIDAD", "enabled": 1 } }
```

---

## POST /api/rules/toggle

Habilitar o deshabilitar una regla.

**Body:**
```json
{ "id": 5, "enabled": false }
```

**Respuesta 200:**
```json
{ "ok": true, "rule": { "id": 5, "enabled": 0 } }
```

---

## POST /api/classifiers

Crear un clasificador configurable.

**Body:**
```json
{
  "name": "Prioridad",
  "description": "Nivel de urgencia del correo",
  "question": "¿Qué prioridad tiene este correo?",
  "type": "choice",
  "options": ["Alta", "Media", "Baja"]
}
```

`type` — `"choice"` (requiere 2-20 opciones) | `"noul"` (sin opciones)

**Respuesta 200:**
```json
{ "ok": true, "classifier": { "id": "prioridad", "name": "Prioridad", ... } }
```

---

## POST /api/classifiers/update

Editar un clasificador existente.

**Body:**
```json
{
  "id": "prioridad",
  "name": "Urgencia",
  "question": "¿Qué urgencia tiene este correo?",
  "options": ["Crítica", "Alta", "Media", "Baja"]
}
```

Editar la pregunta, tipo u opciones sube la versión e invalida la caché del clasificador.

**Respuesta 200:**
```json
{ "ok": true, "classifier": { "id": "prioridad", "version": 2, "criteria": "prioridad:v2", ... } }
```

---

## POST /api/classifiers/toggle

Habilitar o deshabilitar un clasificador.

**Body:**
```json
{ "id": "prioridad", "enabled": false }
```

El clasificador `base` no puede deshabilitarse.

**Respuesta 200:**
```json
{ "ok": true, "classifier": { "id": "prioridad", "enabled": 0 } }
```
