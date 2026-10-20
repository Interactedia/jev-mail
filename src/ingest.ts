import { readFile, rename, writeFile } from "node:fs/promises";
import { decodeWords } from "postal-mime";
import type { Email } from "./jev.js";
import { classifyEmails, type ClassifyRun } from "./classify.js";
import {
  countChangedFlags,
  downloadText,
  errorText,
  findTextPart,
  flagsSnapshot,
  openMailbox,
  readConfig,
  sender,
} from "./imap.js";
import {
  closeDb,
  getCursor,
  identity,
  ingestStats,
  listFetchedUids,
  listPending,
  markFailed,
  markFetched,
  recordDiscovered,
  saveCursor,
  setMessageId,
  type Identity,
} from "./memory.js";

const DEFAULT_BATCH = 50;

interface IngestEmail extends Email {
  uid: number;
  uidValidity: number;
  messageId: string | null;
  date: string;
}

interface Summary {
  [key: string]: unknown;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Fusiona por id sin perder entradas previas (results.json y emails.json son acumulativos). */
function mergeById<T extends { id: string }>(existing: T[] | undefined, incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of existing ?? []) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

async function persistResults(run: ClassifyRun): Promise<void> {
  type StoredResult = { id: string; status: string };
  const previous = await readJsonIfExists<{ results?: StoredResult[] }>("results.json");
  const merged = mergeById<StoredResult>(previous?.results ?? [], run.results as StoredResult[]);
  const ok = merged.filter((result) => result.status === "ok").length;
  const summary: Summary = {
    ...run.summary,
    emails: merged.length,
    succeeded: ok,
    failed: merged.length - ok,
    calls: merged.length,
  };
  await writeJsonAtomic("results.json", { generatedAt: new Date().toISOString(), model: run.model, summary, results: merged });
}

async function persistEmails(incoming: IngestEmail[]): Promise<void> {
  const previous = await readJsonIfExists<IngestEmail[]>("emails.json");
  await writeJsonAtomic("emails.json", mergeById(previous, incoming));
}

import type { ImapFlow } from "imapflow";

async function fetchPending(ident: Identity, client: ImapFlow, limit: number): Promise<{
  emails: IngestEmail[];
  failed: { uid: number; error: string }[];
}> {
  const pending = listPending(ident, limit);
  const emails: IngestEmail[] = [];
  const failed: { uid: number; error: string }[] = [];

  for (const message of pending) {
    try {
      const fetched = await client.fetchOne(String(message.uid), {
        uid: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
      }, { uid: true });
      if (!fetched) throw new Error("El servidor no devolvió el mensaje");

      const textPart = findTextPart(fetched.bodyStructure);
      if (!textPart) throw new Error("sin parte de texto");
      const body = await downloadText(client, message.uid, textPart);
      if (!body) throw new Error("cuerpo vacío");

      const envelope = fetched.envelope;
      const messageId = envelope?.messageId ? envelope.messageId.replace(/^<|>$/g, "") : null;
      setMessageId(ident, message.uid, messageId);

      emails.push({
        id: `imap-${ident.uidValidity}-${message.uid}`,
        uid: message.uid,
        uidValidity: ident.uidValidity,
        messageId,
        from: sender(envelope),
        subject: envelope?.subject ? decodeWords(envelope.subject) : "(sin asunto)",
        date: new Date(fetched.internalDate ?? Date.now()).toISOString(),
        body,
      });
    } catch (error) {
      const message_ = errorText(error);
      failed.push({ uid: message.uid, error: message_ });
      markFailed(ident, message.uid, message_);
      console.error(`UID ${message.uid}: fallo de descarga (${message_}) → FAILED, recuperable`);
    }
  }
  return { emails, failed };
}

async function classifyAndMark(ident: Identity, emails: IngestEmail[]): Promise<void> {
  if (emails.length === 0) return;

  // La clasificación usa el motor existente: reglas/caché por clasificador evitan llamadas a Jev.
  const run = await classifyEmails(emails, { log: false });
  for (const result of run.results) {
    const uid = Number(result.id.split("-").pop());
    if (result.status === "ok") {
      markFetched(ident, uid);
      console.log(`UID ${uid}: FETCHED · ${result.classification.category} [${result.source}]`);
    } else {
      markFailed(ident, uid, result.error);
      console.error(`UID ${uid}: fallo de clasificación (${result.error}) → FAILED, recuperable`);
    }
  }

  await persistEmails(emails);
  await persistResults(run);
  console.log(
    `Clasificación: ${run.summary.succeeded} ok, ${run.summary.failed} errores · Jev ${run.summary.jevCalls} llamadas` +
      ` · regla ${run.summary.bySource.RULE} · caché ${run.summary.bySource.CACHE}`,
  );
}

async function run(mode: "new" | "history", limit: number): Promise<void> {
  const config = readConfig();
  const opened = await openMailbox(config);
  const ident: Identity = { ...identity(), uidValidity: opened.uidValidity };

  try {
    const cursor = getCursor(ident);
    console.log(
      `Conectado a ${config.host}:${config.port} · ${config.mailbox} (readOnly) · UIDVALIDITY ${ident.uidValidity}` +
        ` · mensajes ${opened.exists} · UID más alto ${opened.highestUid}`,
    );

    if (!cursor) {
      console.log(
        `UIDVALIDITY ${ident.uidValidity} es una época nueva (sin cursores previos): no se reutilizan cursores anteriores.`,
      );
    } else {
      console.log(`Cursores de la época: new=${cursor.newCursor} history=${cursor.historyCursor}`);
    }

    let discovered = 0;

    if (mode === "new") {
      const startingPoint = !cursor || cursor.newCursor === 0;
      if (startingPoint) {
        // Primera ejecución: establecer punto de partida SIN clasificar el histórico.
        saveCursor(ident, { newCursor: opened.highestUid, historyCursor: cursor?.historyCursor ?? 0 });
        console.log(`Primera ejecución: punto de partida establecido en UID ${opened.highestUid}. El histórico no se clasifica (usa ingest:history).`);
      } else if (opened.highestUid > cursor.newCursor) {
        // Descubrimiento incremental por UID: solo posteriores al cursor.
        const found = await opened.client.search({ uid: `${cursor.newCursor + 1}:*` }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).filter((uid) => uid > cursor.newCursor);
        // Persistir ANTES de avanzar el cursor.
        discovered = recordDiscovered(ident, uids);
        saveCursor(ident, { newCursor: opened.highestUid });
        console.log(`Nuevos descubiertos: ${uids.length} (UID > ${cursor.newCursor}) · registrados: ${discovered} · cursor → ${opened.highestUid}`);
      } else {
        saveCursor(ident, { newCursor: opened.highestUid });
        console.log(`Sin mensajes nuevos (cursor ${cursor.newCursor}, UID más alto ${opened.highestUid}).`);
      }
    } else {
      // Histórico: descubrir todo el rango por lotes idempotentes.
      const found = await opened.client.search({ uid: "1:*" }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      discovered = recordDiscovered(ident, uids);
      const fetched = listFetchedUids(ident);
      saveCursor(ident, { newCursor: opened.highestUid, historyCursor: opened.highestUid });
      console.log(
        `Histórico: ${uids.length} UIDs en la carpeta · nuevos registros: ${discovered}` +
          ` · ya FETCHED: ${fetched.size} · lote de esta ejecución: ${limit}`,
      );
    }

    const pendingBefore = listPending(ident);
    console.log(`Pendientes (DISCOVERED/FAILED): ${pendingBefore.length}`);
    if (pendingBefore.length === 0) {
      const stats = ingestStats(ident);
      console.log(`Estados: DISCOVERED ${stats.DISCOVERED} · FETCHED ${stats.FETCHED} · FAILED ${stats.FAILED}`);
      return;
    }

    const batchUids = pendingBefore.slice(0, limit).map((message) => message.uid);
    const range = `${Math.min(...batchUids)}:${Math.max(...batchUids)}`;
    const flagsBefore = await flagsSnapshot(opened.client, range, { uid: true });

    const { emails, failed } = await fetchPending(ident, opened.client, limit);
    console.log(`Descargados: ${emails.length} · fallos de descarga: ${failed.length}`);

    await classifyAndMark(ident, emails);

    const flagsAfter = await flagsSnapshot(opened.client, range, { uid: true });
    const changed = countChangedFlags(flagsBefore, flagsAfter);
    console.log(`Flags modificados en el rango ${range}: ${changed}`);
    if (changed > 0) {
      console.error("ALERTA: cambiaron flags en el servidor");
      process.exitCode = 1;
    }

    const stats = ingestStats(ident);
    const pendingAfter = listPending(ident);
    console.log(
      `Estados: DISCOVERED ${stats.DISCOVERED} · FETCHED ${stats.FETCHED} · FAILED ${stats.FAILED}` +
        ` · pendientes restantes: ${pendingAfter.length}`,
    );
    if (mode === "history" && pendingAfter.length > 0) {
      console.log(`El histórico continúa en la próxima ejecución (quedan ${pendingAfter.length}).`);
    }
  } finally {
    await opened.release();
    await opened.close();
    closeDb();
  }
}

function parseArgs(): { mode: "new" | "history"; limit: number } {
  const mode = process.argv[2];
  if (mode !== "new" && mode !== "history") {
    throw new Error("Uso: ingest.js <new|history> [--limit=N]");
  }
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Number(process.env.INGEST_BATCH ?? DEFAULT_BATCH);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit debe ser un entero positivo");
  return { mode, limit };
}

async function main(): Promise<void> {
  const { mode, limit } = parseArgs();
  try {
    await run(mode, limit);
  } catch (error) {
    console.error(`Error de ingesta: ${errorText(error)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Fallo inesperado: ${errorText(error)}`);
  process.exitCode = 1;
});
