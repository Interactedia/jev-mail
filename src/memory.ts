import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CATEGORIES, type Classification, type Usage } from "./jev.js";

const DB_PATH = process.env.JEV_DB_PATH ?? "data/jev.sqlite";

export const BASE_CLASSIFIER_ID = "base";
/** Criteria del clasificador base; se conserva igual que en v1 para no invalidar su caché existente. */
export const CRITERIA_VERSION = "v1-jev-latest";
export const SPAM_THRESHOLD = 0.5;
export const ATTENTION_THRESHOLD = 0.5;
export const NOUL_YES = "sí";
export const NOUL_NO = "no";

export type Source = "JEV" | "RULE" | "CACHE";
export type RuleType = "EMAIL" | "DOMAIN";
export type ClassifierType = "base" | "choice" | "noul";

export interface Classifier {
  id: string;
  name: string;
  description: string;
  question: string;
  type: ClassifierType;
  options: string[];
  enabled: number;
  version: number;
  criteria: string;
  created_at: string;
  updated_at: string;
}

export interface Answer {
  value: string;
  probability: number;
  model: string;
  usage: Usage;
  extra?: Record<string, number>;
}

export interface Resolved {
  classifier: Classifier;
  answer: Answer | null;
  source: Source;
  note: string | null;
}

export interface RuleRow {
  id: number;
  classifier_id: string;
  type: RuleType;
  value: string;
  action: string;
  origin: string;
  enabled: number;
  created_at: string;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

let db: DatabaseSync | undefined;

function rows<T>(database: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return database.prepare(sql).all(...(params as [])) as unknown as T[];
}

function row<T>(database: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return database.prepare(sql).get(...(params as [])) as unknown as T | undefined;
}

function tableNames(database: DatabaseSync): Set<string> {
  return new Set(rows<{ name: string }>(database, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name));
}

/** Migración a esquema v2: clasificadores configurables + reglas y caché por clasificador.
 *  Reversible: las tablas v1 se conservan como `*_v1_backup`. */
function migrate(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // Pasos incrementales e idempotentes: solo se salta todo si ya está en la versión final.
  const currentVersion = Number(
    row<{ value: string }>(database, `SELECT value FROM meta WHERE key = 'schema_version'`)?.value ?? "0",
  );
  if (currentVersion >= 3) return;

  const existing = tableNames(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS classifiers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      question    TEXT NOT NULL DEFAULT '',
      type        TEXT NOT NULL,
      options     TEXT NOT NULL DEFAULT '[]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      version     INTEGER NOT NULL DEFAULT 1,
      criteria    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT OR IGNORE INTO classifiers (id, name, description, question, type, options, enabled, version, criteria, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'base', ?, 1, 1, ?, ?, ?)`,
    )
    .run(
      BASE_CLASSIFIER_ID,
      "Base",
      "Clasificador original: categoría Trabajo/Personal/Indeterminado, probabilidad de spam y de requerir atención.",
      "Clasifica el correo según su propósito principal.",
      JSON.stringify([...CATEGORIES]),
      CRITERIA_VERSION,
      now,
      now,
    );

  if (existing.has("rules") && !existing.has("rules_v1_backup")) {
    database.exec(`ALTER TABLE rules RENAME TO rules_v1_backup;`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      classifier_id TEXT NOT NULL,
      type          TEXT NOT NULL,
      value         TEXT NOT NULL,
      action        TEXT NOT NULL,
      origin        TEXT NOT NULL DEFAULT 'MANUAL',
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      UNIQUE (classifier_id, type, value)
    );
  `);
  if (tableNames(database).has("rules_v1_backup")) {
    database.exec(`
      INSERT OR IGNORE INTO rules (id, classifier_id, type, value, action, origin, enabled, created_at)
      SELECT id, '${BASE_CLASSIFIER_ID}', type, value, action, origin, enabled, created_at FROM rules_v1_backup;
    `);
  }

  if (existing.has("classifications") && !existing.has("classifications_v1_backup")) {
    database.exec(`ALTER TABLE classifications RENAME TO classifications_v1_backup;`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS classifications (
      classifier_id TEXT NOT NULL,
      email_id      TEXT NOT NULL,
      sender        TEXT NOT NULL,
      domain        TEXT NOT NULL,
      classification TEXT NOT NULL,
      probability   REAL NOT NULL,
      source        TEXT NOT NULL,
      criteria      TEXT NOT NULL,
      model         TEXT NOT NULL,
      detail        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (classifier_id, email_id, criteria)
    );
  `);
  if (tableNames(database).has("classifications_v1_backup")) {
    database.exec(`
      INSERT OR IGNORE INTO classifications
        (classifier_id, email_id, sender, domain, classification, probability, source, criteria, model, detail, created_at)
      SELECT '${BASE_CLASSIFIER_ID}', email_id, sender, domain, classification, probability, source, criteria, model, detail, created_at
      FROM classifications_v1_backup;
    `);
  }

  if (Number(row<{ value: string }>(database, `SELECT value FROM meta WHERE key = 'schema_version'`)?.value ?? "2") < 3) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ingest_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id    TEXT NOT NULL,
        mailbox       TEXT NOT NULL,
        uid_validity  INTEGER NOT NULL,
        uid           INTEGER NOT NULL,
        message_id    TEXT,
        status        TEXT NOT NULL DEFAULT 'DISCOVERED',
        discovered_at TEXT NOT NULL,
        fetched_at    TEXT,
        failed_at     TEXT,
        last_error    TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        UNIQUE (account_id, mailbox, uid_validity, uid)
      );
      CREATE INDEX IF NOT EXISTS ingest_messages_pending
        ON ingest_messages (account_id, mailbox, uid_validity, status, uid);
      CREATE TABLE IF NOT EXISTS ingest_cursors (
        account_id   TEXT NOT NULL,
        mailbox      TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        new_cursor   INTEGER NOT NULL DEFAULT 0,
        history_cursor INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (account_id, mailbox, uid_validity)
      );
    `);
    database
      .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '3') ON CONFLICT (key) DO UPDATE SET value = '3'`)
      .run();
  }
}

/** ponytail: los fallos de SQLite se silencian y degradan a "consultar siempre a Jev"; así una BD corrupta nunca inventa clasificaciones. */
function withDb<T>(work: (database: DatabaseSync) => T, fallback: T): T {
  try {
    if (!db) {
      mkdirSync("data", { recursive: true });
      db = new DatabaseSync(DB_PATH);
      db.exec(`PRAGMA journal_mode = WAL;`);
      migrate(db);
    }
    return work(db);
  } catch (error) {
    console.warn(`SQLite no disponible, se continúa sin memoria: ${(error as Error).message}`);
    db = undefined;
    return fallback;
  }
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    // ya cerrada
  }
  db = undefined;
}

/* ---------------------------------- remitentes ---------------------------------- */

export function normalizeAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle?.[1] ?? value).trim().toLowerCase().replace(/\s+/g, "");
}

export function domainOf(value: string): string {
  return splitSender(value).domain;
}

/** Acepta "dominio.com", "Persona <p@dominio.com>" o "p@dominio.com"; devuelve dirección y dominio exactos. */
export function splitSender(value: string): { email: string; domain: string } {
  const raw = value.trim().toLowerCase();
  const address = raw.includes("@") ? normalizeAddress(raw) : raw.replace(/^\.+|\.+$/g, "");
  const at = address.lastIndexOf("@");
  return at >= 0 ? { email: address, domain: address.slice(at + 1) } : { email: "", domain: address };
}

/* ---------------------------------- clasificadores ---------------------------------- */

function parseClassifier(record: Record<string, unknown>): Classifier {
  let options: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(record.options ?? "[]"));
    if (Array.isArray(parsed)) options = parsed.map((option) => String(option));
  } catch {
    options = [];
  }
  return {
    id: String(record.id),
    name: String(record.name),
    description: String(record.description ?? ""),
    question: String(record.question ?? ""),
    type: String(record.type) as ClassifierType,
    options,
    enabled: Number(record.enabled),
    version: Number(record.version),
    criteria: String(record.criteria),
    created_at: String(record.created_at),
    updated_at: String(record.updated_at),
  };
}

export function listClassifiers(): Classifier[] {
  return withDb(
    (database) => rows<Record<string, unknown>>(database, `SELECT * FROM classifiers ORDER BY id`).map(parseClassifier),
    [],
  );
}

export function getClassifier(id: string): Classifier | undefined {
  return withDb(
    (database) => {
      const found = row<Record<string, unknown>>(database, `SELECT * FROM classifiers WHERE id = ?`, id);
      return found ? parseClassifier(found) : undefined;
    },
    undefined,
  );
}

export function enabledClassifiers(): Classifier[] {
  return listClassifiers().filter((classifier) => classifier.enabled === 1);
}

function slugify(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clasificador";
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

function cleanOptions(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\n,]/) : [];
  const options = raw.map((option) => String(option).trim()).filter((option) => option.length > 0);
  return [...new Set(options)];
}

function validateSemantics(input: {
  name?: unknown;
  question?: unknown;
  type?: unknown;
  options?: unknown;
}): { name: string; question: string; type: ClassifierType; options: string[] } {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 60) throw new Error("Nombre de clasificador inválido (1-60 caracteres)");
  const question = String(input.question ?? "").trim();
  if (!question || question.length > 500) throw new Error("Pregunta inválida (1-500 caracteres)");
  const type = String(input.type ?? "").toLowerCase();
  if (type !== "choice" && type !== "noul") throw new Error("Tipo inválido (choice o noul)");
  const options = cleanOptions(input.options);
  if (type === "choice") {
    if (options.length < 2 || options.length > 20) throw new Error("Un clasificador choice necesita 2-20 opciones");
    if (options.some((option) => option.length > 60)) throw new Error("Cada opción debe tener como máximo 60 caracteres");
  } else if (options.length > 0) {
    throw new Error("Un clasificador noul no admite opciones");
  }
  return { name, question, type, options };
}

export function createClassifier(input: {
  name: string;
  description?: string;
  question: string;
  type: string;
  options?: unknown;
}): Classifier {
  const semantics = validateSemantics(input);
  const description = String(input.description ?? "").trim().slice(0, 300);
  return withDb((database) => {
    const taken = new Set(rows<{ id: string }>(database, `SELECT id FROM classifiers`).map((r) => r.id));
    const id = slugify(semantics.name, taken);
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO classifiers (id, name, description, question, type, options, enabled, version, criteria, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
      )
      .run(id, semantics.name, description, semantics.question, semantics.type, JSON.stringify(semantics.options), `${id}:v1`, now, now);
    return parseClassifier(row<Record<string, unknown>>(database, `SELECT * FROM classifiers WHERE id = ?`, id)!);
  }, undefined as unknown as Classifier) as Classifier;
}

/** Editar la semántica (pregunta/tipo/opciones) sube la versión y cambia el criteria: la caché anterior deja de aplicar. */
export function updateClassifier(
  id: string,
  patch: { name?: string; description?: string; question?: string; type?: string; options?: unknown },
): Classifier {
  // Validación FUERA de withDb: si fallara dentro, withDb la silenciaría y degradaría a un falso éxito.
  const current = getClassifier(id);
  if (!current) throw new Error("Clasificador no encontrado");
  if (current.type === "base") throw new Error("El clasificador base no es editable");

  const semantics = validateSemantics({
    name: patch.name ?? current.name,
    question: patch.question ?? current.question,
    type: patch.type ?? current.type,
    options: patch.options ?? current.options,
  });
  const semanticChange =
    semantics.question !== current.question ||
    semantics.type !== current.type ||
    semantics.options.join("|") !== current.options.join("|");
  const version = semanticChange ? current.version + 1 : current.version;
  const criteria = semanticChange ? `${id}:v${version}` : current.criteria;
  const description = patch.description !== undefined ? String(patch.description).trim().slice(0, 300) : current.description;

  return withDb((database) => {
    database
      .prepare(
        `UPDATE classifiers SET name = ?, description = ?, question = ?, type = ?, options = ?, version = ?, criteria = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        semantics.name,
        description,
        semantics.question,
        semantics.type,
        JSON.stringify(semantics.options),
        version,
        criteria,
        new Date().toISOString(),
        id,
      );
    return parseClassifier(row<Record<string, unknown>>(database, `SELECT * FROM classifiers WHERE id = ?`, id)!);
  }, undefined as unknown as Classifier) as Classifier;
}

export function setClassifierEnabled(id: string, enabled: boolean): Classifier | undefined {
  const current = getClassifier(id);
  if (!current) return undefined;
  if (current.type === "base" && !enabled) throw new Error("El clasificador base no puede deshabilitarse");
  return withDb((database) => {
    database
      .prepare(`UPDATE classifiers SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return parseClassifier(row<Record<string, unknown>>(database, `SELECT * FROM classifiers WHERE id = ?`, id)!);
  }, undefined);
}

/* ---------------------------------- reglas ---------------------------------- */

function asRule(record: Record<string, unknown>): RuleRow {
  return {
    id: Number(record.id),
    classifier_id: String(record.classifier_id),
    type: String(record.type) as RuleType,
    value: String(record.value),
    action: String(record.action),
    origin: String(record.origin),
    enabled: Number(record.enabled),
    created_at: String(record.created_at),
  };
}

/** Acción válida según el clasificador: base usa PUBLICIDAD/MANTENER, choice una opción, noul sí/no. */
export function normalizeAction(classifier: Classifier, action: string): string {
  const raw = action.trim();
  if (classifier.type === "base") {
    const upper = raw.toUpperCase();
    if (upper !== "PUBLICIDAD" && upper !== "MANTENER") throw new Error("Acción inválida para el clasificador base");
    return upper;
  }
  if (classifier.type === "choice") {
    const match = classifier.options.find((option) => option.toLowerCase() === raw.toLowerCase());
    if (!match) throw new Error(`Acción inválida: debe ser una de [${classifier.options.join(", ")}]`);
    return match;
  }
  const lower = raw.toLowerCase();
  if (["sí", "si", "yes", "true", "1"].includes(lower)) return NOUL_YES;
  if (["no", "false", "0"].includes(lower)) return NOUL_NO;
  throw new Error("Acción inválida para noul: sí o no");
}

export function listRules(classifierId?: string): RuleRow[] {
  return withDb((database) => {
    const records = classifierId
      ? rows<Record<string, unknown>>(database, `SELECT * FROM rules WHERE classifier_id = ? ORDER BY id`, classifierId)
      : rows<Record<string, unknown>>(database, `SELECT * FROM rules ORDER BY id`);
    return records.map(asRule);
  }, []);
}

/** Regla exacta de dirección y, si no, de dominio. Nunca propaga a subdominios. */
export function findRule(classifierId: string, address: string): RuleRow | undefined {
  const { email, domain } = splitSender(address);
  return withDb((database) => {
    if (email) {
      const byEmail = row<Record<string, unknown>>(
        database,
        `SELECT * FROM rules WHERE enabled = 1 AND classifier_id = ? AND type = 'EMAIL' AND value = ?`,
        classifierId,
        email,
      );
      if (byEmail) return asRule(byEmail);
    }
    if (!domain) return undefined;
    const byDomain = row<Record<string, unknown>>(
      database,
      `SELECT * FROM rules WHERE enabled = 1 AND classifier_id = ? AND type = 'DOMAIN' AND value = ?`,
      classifierId,
      domain,
    );
    return byDomain ? asRule(byDomain) : undefined;
  }, undefined);
}

export function createRule(input: { classifierId: string; type: string; value: string; action: string }): RuleRow {
  const type = input.type.toUpperCase();
  if (type !== "EMAIL" && type !== "DOMAIN") throw new Error("Tipo de regla inválido (EMAIL o DOMAIN)");
  const classifier = getClassifier(input.classifierId);
  if (!classifier) throw new Error("Clasificador no encontrado");
  const parsed = splitSender(input.value);
  const value = type === "EMAIL" ? parsed.email : parsed.domain;
  if (!value) throw new Error("Valor de regla inválido");
  const action = normalizeAction(classifier, input.action);

  return withDb((database) => {
    database
      .prepare(
        `INSERT INTO rules (classifier_id, type, value, action, origin, enabled, created_at) VALUES (?, ?, ?, ?, 'MANUAL', 1, ?)
         ON CONFLICT (classifier_id, type, value) DO UPDATE SET action = excluded.action, enabled = 1, origin = 'MANUAL'`,
      )
      .run(classifier.id, type, value, action, new Date().toISOString());
    return asRule(
      row<Record<string, unknown>>(
        database,
        `SELECT * FROM rules WHERE classifier_id = ? AND type = ? AND value = ?`,
        classifier.id,
        type,
        value,
      )!,
    );
  }, undefined as unknown as RuleRow) as RuleRow;
}

export function setRuleEnabled(id: number, enabled: boolean): RuleRow | undefined {
  return withDb((database) => {
    database.prepare(`UPDATE rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    const found = row<Record<string, unknown>>(database, `SELECT * FROM rules WHERE id = ?`, id);
    return found ? asRule(found) : undefined;
  }, undefined);
}

/** Una regla manual fuerza la respuesta del clasificador; no es una predicción ni autoriza acciones. */
export function answerFromRule(classifier: Classifier, rule: RuleRow): Answer {
  const model = `regla:${rule.type}`;
  if (classifier.type === "base") {
    const publicidad = rule.action === "PUBLICIDAD";
    return {
      value: "Trabajo",
      probability: 1,
      model,
      usage: ZERO_USAGE,
      extra: { spam: publicidad ? 1 : 0, attention: publicidad ? 0 : 0.5 },
    };
  }
  if (classifier.type === "noul") {
    return { value: rule.action, probability: rule.action === NOUL_YES ? 1 : 0, model, usage: ZERO_USAGE };
  }
  return { value: rule.action, probability: 1, model, usage: ZERO_USAGE };
}

/* ---------------------------------- caché ---------------------------------- */

/** Convierte una Classification legada (v1) al formato Answer. */
export function legacyToAnswer(classification: Classification): Answer {
  return {
    value: classification.category,
    probability: classification.categoryConfidence,
    model: classification.model,
    usage: ZERO_USAGE,
    extra: {
      spam: classification.spamProbability,
      attention: classification.needsAttentionProbability,
    },
  };
}

export function answerToClassification(classifier: Classifier, answer: Answer): Classification {
  const category = CATEGORIES.includes(answer.value as (typeof CATEGORIES)[number])
    ? (answer.value as Classification["category"])
    : "Indeterminado";
  return {
    category,
    categoryConfidence: answer.probability,
    spamProbability: answer.extra?.spam ?? 0,
    needsAttentionProbability: answer.extra?.attention ?? 0,
    model: answer.model,
    usage: answer.usage,
  };
}

function parseDetail(classifier: Classifier, detail: string): Answer {
  const parsed = JSON.parse(detail) as Record<string, unknown>;
  if (typeof parsed.category === "string") {
    return legacyToAnswer(parsed as unknown as Classification);
  }
  return {
    value: String(parsed.value),
    probability: Number(parsed.probability),
    model: String(parsed.model),
    usage: ZERO_USAGE,
    extra: parsed.extra as Record<string, number> | undefined,
  };
}

/** Caché válida solo para el mismo clasificador Y el mismo criteria. */
export function findCached(classifier: Classifier, emailId: string): Resolved {
  const miss: Resolved = { classifier, answer: null, source: "JEV", note: null };
  return withDb((database) => {
    const found = row<Record<string, unknown>>(
      database,
      `SELECT * FROM classifications WHERE classifier_id = ? AND email_id = ? AND criteria = ?`,
      classifier.id,
      emailId,
      classifier.criteria,
    );
    if (!found) return miss;
    return {
      classifier,
      answer: parseDetail(classifier, String(found.detail)),
      source: "CACHE",
      note: `caché de criteria ${String(found.criteria)}`,
    } satisfies Resolved;
  }, miss);
}

export function saveAnswer(
  classifier: Classifier,
  emailId: string,
  sender: string,
  answer: Answer,
  source: Source,
): void {
  const { email, domain } = splitSender(sender);
  if (!domain) return;
  withDb(
    (database) =>
      database
        .prepare(
          `INSERT INTO classifications
             (classifier_id, email_id, sender, domain, classification, probability, source, criteria, model, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (classifier_id, email_id, criteria) DO UPDATE SET
             sender = excluded.sender, domain = excluded.domain, classification = excluded.classification,
             probability = excluded.probability, source = excluded.source, model = excluded.model,
             detail = excluded.detail, created_at = excluded.created_at`,
        )
        .run(
          classifier.id,
          emailId,
          email || sender,
          domain,
          answer.value,
          answer.probability,
          source,
          classifier.criteria,
          answer.model,
          JSON.stringify(answer),
          new Date().toISOString(),
        ),
    undefined,
  );
}

/** Orden de resolución por clasificador: A) regla EMAIL, B) regla DOMAIN, C) caché, D) Jev. */
export function resolveClassifier(classifier: Classifier, emailId: string, sender: string): Resolved {
  const rule = findRule(classifier.id, sender);
  if (rule) {
    return {
      classifier,
      answer: answerFromRule(classifier, rule),
      source: "RULE",
      note: `regla ${rule.type} ${rule.value} → ${rule.action}`,
    };
  }
  return findCached(classifier, emailId);
}

/* ---------------------------------- ingesta IMAP ---------------------------------- */

export type IngestStatus = "DISCOVERED" | "FETCHED" | "FAILED";

export interface IngestMessage {
  id: number;
  account_id: string;
  mailbox: string;
  uid_validity: number;
  uid: number;
  message_id: string | null;
  status: IngestStatus;
  attempts: number;
  last_error: string | null;
}

export interface Identity {
  account: string;
  mailbox: string;
  uidValidity: number;
}

export interface IngestCursor {
  newCursor: number;
  historyCursor: number;
}

function asIngestMessage(record: Record<string, unknown>): IngestMessage {
  return {
    id: Number(record.id),
    account_id: String(record.account_id),
    mailbox: String(record.mailbox),
    uid_validity: Number(record.uid_validity),
    uid: Number(record.uid),
    message_id: record.message_id === null || record.message_id === undefined ? null : String(record.message_id),
    status: String(record.status) as IngestStatus,
    attempts: Number(record.attempts),
    last_error: record.last_error === null || record.last_error === undefined ? null : String(record.last_error),
  };
}

export function identity(): Identity {
  return {
    account: process.env.IMAP_USER ?? "local",
    mailbox: process.env.IMAP_MAILBOX ?? "INBOX",
    uidValidity: 0,
  };
}

/** Inserta identidades descubiertas sin duplicar. Devuelve cuántas eran nuevas.
 *  UNIQUE (account_id, mailbox, uid_validity, uid) hace idempotente el descubrimiento. */
export function recordDiscovered(identity_: Identity, uids: number[]): number {
  if (uids.length === 0) return 0;
  return withDb((database) => {
    const statement = database.prepare(
      `INSERT OR IGNORE INTO ingest_messages (account_id, mailbox, uid_validity, uid, status, discovered_at, attempts)
       VALUES (?, ?, ?, ?, 'DISCOVERED', ?, 0)`,
    );
    const now = new Date().toISOString();
    let inserted = 0;
    for (const uid of uids) {
      const result = statement.run(identity_.account, identity_.mailbox, identity_.uidValidity, uid, now);
      inserted += Number(result.changes);
    }
    return inserted;
  }, 0);
}

export function setMessageId(identity_: Identity, uid: number, messageId: string | null): void {
  withDb(
    (database) =>
      database
        .prepare(
          `UPDATE ingest_messages SET message_id = COALESCE(?, message_id)
           WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`,
        )
        .run(messageId, identity_.account, identity_.mailbox, identity_.uidValidity, uid),
    undefined,
  );
}

export function markFetched(identity_: Identity, uid: number): void {
  withDb(
    (database) =>
      database
        .prepare(
          `UPDATE ingest_messages SET status = 'FETCHED', fetched_at = ?, failed_at = NULL, last_error = NULL, attempts = attempts + 1
           WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`,
        )
        .run(new Date().toISOString(), identity_.account, identity_.mailbox, identity_.uidValidity, uid),
    undefined,
  );
}

export function markFailed(identity_: Identity, uid: number, error: string): void {
  withDb(
    (database) =>
      database
        .prepare(
          `UPDATE ingest_messages SET status = 'FAILED', failed_at = ?, last_error = ?, attempts = attempts + 1
           WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`,
        )
        .run(new Date().toISOString(), error.slice(0, 500), identity_.account, identity_.mailbox, identity_.uidValidity, uid),
    undefined,
  );
}

/** Pendientes recuperables: DISCOVERED o FAILED de la época actual, en orden de UID. */
export function listPending(identity_: Identity, limit = Number.POSITIVE_INFINITY): IngestMessage[] {
  return withDb((database) => {
    const found = rows<Record<string, unknown>>(
      database,
      `SELECT * FROM ingest_messages
       WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND status IN ('DISCOVERED', 'FAILED')
       ORDER BY uid ASC`,
      identity_.account,
      identity_.mailbox,
      identity_.uidValidity,
    ).map(asIngestMessage);
    return Number.isFinite(limit) ? found.slice(0, limit) : found;
  }, []);
}

/** UIDs ya FETCHED en la época actual (para no reclasificar lo vigente). */
export function listFetchedUids(identity_: Identity): Set<number> {
  return withDb(
    (database) =>
      new Set(
        rows<{ uid: number }>(
          database,
          `SELECT uid FROM ingest_messages
           WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND status = 'FETCHED'`,
          identity_.account,
          identity_.mailbox,
          identity_.uidValidity,
        ).map((record) => Number(record.uid)),
      ),
    new Set<number>(),
  );
}

export function getCursor(identity_: Identity): IngestCursor | undefined {
  return withDb((database) => {
    const found = row<Record<string, unknown>>(
      database,
      `SELECT * FROM ingest_cursors WHERE account_id = ? AND mailbox = ? AND uid_validity = ?`,
      identity_.account,
      identity_.mailbox,
      identity_.uidValidity,
    );
    if (!found) return undefined;
    return { newCursor: Number(found.new_cursor), historyCursor: Number(found.history_cursor) };
  }, undefined);
}

/** El cursor solo avanza después de persistir los mensajes descubiertos. */
export function saveCursor(identity_: Identity, cursor: Partial<IngestCursor>): void {
  withDb(
    (database) =>
      database
        .prepare(
          `INSERT INTO ingest_cursors (account_id, mailbox, uid_validity, new_cursor, history_cursor, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, mailbox, uid_validity) DO UPDATE SET
             new_cursor = CASE WHEN excluded.new_cursor > ingest_cursors.new_cursor THEN excluded.new_cursor ELSE ingest_cursors.new_cursor END,
             history_cursor = CASE WHEN excluded.history_cursor > ingest_cursors.history_cursor THEN excluded.history_cursor ELSE ingest_cursors.history_cursor END,
             updated_at = excluded.updated_at`,
        )
        .run(
          identity_.account,
          identity_.mailbox,
          identity_.uidValidity,
          cursor.newCursor ?? 0,
          cursor.historyCursor ?? 0,
          new Date().toISOString(),
        ),
    undefined,
  );
}

/** Una época de UIDVALIDITY distinta empieza sin cursores: no se reutilizan los anteriores. */
export function listEpochs(): { account_id: string; mailbox: string; uid_validity: number; new_cursor: number; history_cursor: number; updated_at: string }[] {
  return withDb(
    (database) =>
      rows<Record<string, unknown>>(database, `SELECT * FROM ingest_cursors ORDER BY updated_at DESC`).map((record) => ({
        account_id: String(record.account_id),
        mailbox: String(record.mailbox),
        uid_validity: Number(record.uid_validity),
        new_cursor: Number(record.new_cursor),
        history_cursor: Number(record.history_cursor),
        updated_at: String(record.updated_at),
      })),
    [],
  );
}

export function ingestStats(identity_: Identity): Record<IngestStatus, number> {
  const stats: Record<IngestStatus, number> = { DISCOVERED: 0, FETCHED: 0, FAILED: 0 };
  return withDb((database) => {
    for (const record of rows<{ status: string; n: number }>(
      database,
      `SELECT status, COUNT(*) n FROM ingest_messages
       WHERE account_id = ? AND mailbox = ? AND uid_validity = ? GROUP BY status`,
      identity_.account,
      identity_.mailbox,
      identity_.uidValidity,
    )) {
      const status = String(record.status) as IngestStatus;
      if (status in stats) stats[status] = Number(record.n);
    }
    return stats;
  }, stats);
}
