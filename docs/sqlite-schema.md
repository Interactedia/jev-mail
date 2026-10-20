# Esquema SQLite

Base de datos: `data/jev.sqlite` (gitignored). Módulo nativo `node:sqlite` con PRAGMA `journal_mode = WAL`.

## Migraciones

El esquema evoluciona de forma aditiva. Las tablas v1 se renombran a `*_v1_backup` al migrar a v2, conservando los datos por si se necesita rollback manual.

| Versión | Cambio |
|---|---|
| v1 | Tablas `rules` y `classifications` planas |
| v2 | Tablas `classifiers`, `rules` y `classifications` con `classifier_id`; backup de v1 |
| v3 | Tablas `ingest_messages` e `ingest_cursors` para ingesta incremental |

## Tablas

### meta

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Clave: 'schema_version', valor: '3'
```

### classifiers

```sql
CREATE TABLE classifiers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  question    TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL,  -- 'base' | 'choice' | 'noul'
  options     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  enabled     INTEGER NOT NULL DEFAULT 1,
  version     INTEGER NOT NULL DEFAULT 1,
  criteria    TEXT NOT NULL,  -- 'base_id:v{N}' o 'classifier_id:v{N}'
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

- `base` es el clasificador original; no editable ni deshabilitable.
- `criteria` es el identificador de la semántica activa. Si cambia (por editar pregunta/tipo/opciones), la caché con `criteria` anterior deja de aplicar.

### rules

```sql
CREATE TABLE rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  classifier_id TEXT NOT NULL,
  type          TEXT NOT NULL,  -- 'EMAIL' | 'DOMAIN'
  value         TEXT NOT NULL,  -- dirección exacta o dominio
  action        TEXT NOT NULL,  -- según el clasificador
  origin        TEXT NOT NULL DEFAULT 'MANUAL',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (classifier_id, type, value)
);
```

- `origin = 'MANUAL'`: las reglas nunca se crean automáticamente.
- EMAIL = dirección exacta (`usuario@dominio.com`); DOMAIN = dominio exacto (`dominio.com`, no `sub.dominio.com`).

### classifications

```sql
CREATE TABLE classifications (
  classifier_id TEXT NOT NULL,
  email_id      TEXT NOT NULL,
  sender        TEXT NOT NULL,
  domain        TEXT NOT NULL,
  classification TEXT NOT NULL,  -- valor de la respuesta
  probability   REAL NOT NULL,
  source        TEXT NOT NULL,  -- 'JEV' | 'RULE' | 'CACHE'
  criteria      TEXT NOT NULL,
  model         TEXT NOT NULL,
  detail        TEXT NOT NULL,  -- JSON: { value, probability, model, usage, extra? }
  created_at    TEXT NOT NULL,
  PRIMARY KEY (classifier_id, email_id, criteria)
);
```

- La clave `(classifier_id, email_id, criteria)` garantiza que la caché solo aplica cuando el clasificador tiene la misma semántica que la usó.
- `source`: indica cómo se obtuvo la decisión (útil para métricas).

### ingest_messages

```sql
CREATE TABLE ingest_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  mailbox       TEXT NOT NULL,
  uid_validity  INTEGER NOT NULL,
  uid           INTEGER NOT NULL,
  message_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'DISCOVERED',  -- DISCOVERED | FETCHED | FAILED
  discovered_at TEXT NOT NULL,
  fetched_at    TEXT,
  failed_at     TEXT,
  last_error    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, mailbox, uid_validity, uid)
);
CREATE INDEX ingest_messages_pending
  ON ingest_messages (account_id, mailbox, uid_validity, status, uid);
```

### ingest_cursors

```sql
CREATE TABLE ingest_cursors (
  account_id      TEXT NOT NULL,
  mailbox         TEXT NOT NULL,
  uid_validity    INTEGER NOT NULL,
  new_cursor     INTEGER NOT NULL DEFAULT 0,
  history_cursor  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (account_id, mailbox, uid_validity)
);
```

- `new_cursor`: UID máximo descubierto en modo `new`.
- `history_cursor`: UID máximo procesado en modo `history`.
- Cada época (`uid_validity`) tiene su propio cursor; épocas anteriores no se reutilizan.
