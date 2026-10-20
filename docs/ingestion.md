# Ingesta incremental

gev-mail soporta dos modos de ingesta que complementan `fetch:emails`:

## ingest:new — Mensajes nuevos

```bash
npm run ingest:new
# o con límite
npm run ingest:new -- --limit=10
node --experimental-sqlite dist/ingest.js new --limit=10
```

**Primera ejecución:** descubre UIDs del servidor y fija el cursor. No clasifica el histórico.

**Ejecuciones siguientes:** procesa mensajes pendientes (DISCOVERED o FAILED) del lote actual. Solo avanza el cursor si la descarga persiste exitosamente.

## ingest:history — Histórico

```bash
npm run ingest:history
# o con límite
INGEST_BATCH=20 npm run ingest:history
node --experimental-sqlite dist/ingest.js history --limit=100
```

Recorre el buzón completo en lotes de 50 (configurable con `--limit=N` o `INGEST_BATCH`). Continúa donde quedó el cursor en ejecuciones anteriores; no reclasifica lo ya procesado.

## Estados de mensaje

| Estado | Significado |
|---|---|
| `DISCOVERED` | UID conocido, aún no descargado |
| `FETCHED` | Descargado y clasificado exitosamente |
| `FAILED` | Falló (descarga o clasificación); recuperable |

## Épocas de UIDVALIDITY

Cuando cambia el `UIDVALIDITY` del buzón (ej. tras un respaldo/restore), se inicia una época nueva. Los cursores y pendientes de épocas anteriores no se reutilizan. El proceso detecta el cambio y empieza a rastrear desde cero para esa cuenta/carpeta.

## Límite de intentos

Cada intento de descarga o clasificación incrementa `attempts` en la base. Los fallos se registran en `last_error` (máx. 500 caracteres). El proceso no tiene límite fijo de intentos; los pendientes se reintentan mientras sigan en cola.

## Resumen del proceso

```
1. Descubrir UIDs (SEARCH {uid})
   ↓
2. Insertar en ingest_messages (INSERT OR IGNORE, idempotente)
   ↓
3. Avanzar cursor de descubrimiento
   ↓
4. Descargar pendientes (DISCOVERED/FAILED)
   ↓
5. Clasificar con classifyEmails()
   ↓
6. Fusionar resultados en emails.json + results.json
```
