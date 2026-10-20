import { readFile, writeFile } from "node:fs/promises";
import {
  JevError,
  baseAnswer,
  baseQuestions,
  classifyWithJev,
  questionFor,
  type Classification,
  type Email,
  type JevQuestion,
  type Usage,
} from "./jev.js";
import {
  BASE_CLASSIFIER_ID,
  answerToClassification,
  closeDb,
  enabledClassifiers,
  resolveClassifier,
  saveAnswer,
  type Answer,
  type Classifier,
  type Resolved,
  type Source,
} from "./memory.js";

interface ClassifierResult {
  classifierId: string;
  classifierName: string;
  type: string;
  version: number;
  criteria: string;
  value: string;
  probability: number;
  extra: Record<string, number> | null;
  source: Source;
  model: string | null;
  note: string | null;
}

interface OkResult {
  id: string;
  subject: string;
  status: "ok";
  classification: Classification;
  source: Source;
  classifiers: ClassifierResult[];
}

interface ErrorResult {
  id: string;
  subject: string;
  status: "error";
  error: string;
  httpStatus: number | null;
}

type Result = OkResult | ErrorResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEmails(raw: string): Email[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("emails.json debe contener un array no vacío");
  }
  return data.map((item, index) => {
    if (!isRecord(item)) throw new Error(`emails.json: el correo #${index} no es un objeto`);
    const { id, from, subject, body } = item;
    for (const [field, value] of Object.entries({ id, from, subject, body })) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`emails.json: el correo #${index} tiene '${field}' inválido`);
      }
    }
    return { id, from, subject, body } as Email;
  });
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function errorMessage(error: unknown): { message: string; httpStatus: number | null } {
  if (error instanceof JevError) {
    return { message: error.message, httpStatus: error.httpStatus ?? null };
  }
  if (error instanceof Error) {
    return { message: error.message, httpStatus: null };
  }
  return { message: String(error), httpStatus: null };
}

function toAnswer(value: string, probability: number, model: string, usage: Usage, extra?: Record<string, number>): Answer {
  return { value, probability, model, usage, extra };
}

export interface ClassifySummary {
  emails: number;
  succeeded: number;
  failed: number;
  calls: number;
  jevCalls: number;
  bySource: Record<Source, number>;
  avoidedCalls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifyRun {
  model: string;
  results: Result[];
  summary: ClassifySummary;
}

/** Motor de clasificación reutilizable: resuelve regla/caché/Jev por clasificador.
 *  No escribe archivos ni toca IMAP; el llamador decide qué persistir. */
export async function classifyEmails(emails: Email[], options: { log?: boolean } = {}): Promise<ClassifyRun> {
  const log = options.log ?? false;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error("Falta TYPESAFE_API_KEY. Copia .env.example a .env y añade tu clave.");
  }

  const model = "jev-latest";
  const classifiers = enabledClassifiers();
  const base = classifiers.find((classifier) => classifier.id === BASE_CLASSIFIER_ID);
  const customs = classifiers.filter((classifier) => classifier.id !== BASE_CLASSIFIER_ID);
  const results: Result[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const origin: Record<Source, number> = { JEV: 0, RULE: 0, CACHE: 0 };
  let jevCalls = 0;
  const startedAt = Date.now();

  if (log) {
    console.log(
      `Clasificando ${emails.length} correos con ${model} · clasificadores: ${classifiers.length}` +
        ` (base ${base ? "activo" : "no encontrado"}${customs.length ? `, ${customs.map((c) => c.id).join(", ")}` : ""})...\n`,
    );
  }

  for (const [index, email] of emails.entries()) {
    const label = `[${index + 1}/${emails.length}] ${email.id}`;
    const emailStartedAt = Date.now();
    try {
      // A/B/C por clasificador: regla EMAIL > regla DOMAIN > caché; D) Jev solo para lo pendiente.
      const resolved = new Map<string, Resolved>();
      for (const classifier of classifiers) {
        resolved.set(classifier.id, resolveClassifier(classifier, email.id, email.from));
      }

      const pending = classifiers.filter((classifier) => !resolved.get(classifier.id)?.answer);
      let batchModel: string | null = null;

      if (pending.length > 0) {
        const questions: JevQuestion[] = [];
        const needsBase = pending.some((classifier) => classifier.id === BASE_CLASSIFIER_ID);
        if (needsBase) questions.push(...baseQuestions());
        for (const classifier of pending) {
          if (classifier.id !== BASE_CLASSIFIER_ID) questions.push(questionFor(classifier));
        }
        // Una única petición conjunta cuando varios clasificadores necesitan Jev.
        const batch = await classifyWithJev(email, questions, apiKey, model);
        jevCalls += 1;
        usage.inputTokens += batch.usage.inputTokens;
        usage.outputTokens += batch.usage.outputTokens;
        batchModel = batch.model;

        if (needsBase) {
          const legacy = baseAnswer(batch);
          const answer = toAnswer(
            legacy.category,
            legacy.categoryConfidence,
            batch.model,
            batch.usage,
            { spam: legacy.spamProbability, attention: legacy.needsAttentionProbability },
          );
          const baseClassifier = base ?? ({ id: BASE_CLASSIFIER_ID, type: "base", criteria: "v1" } as Classifier);
          resolved.set(BASE_CLASSIFIER_ID, { classifier: baseClassifier, answer, source: "JEV", note: null });
        }
        for (const classifier of pending) {
          if (classifier.id === BASE_CLASSIFIER_ID) continue;
          const answer = batch.answers.get(classifier.id);
          if (!answer) throw new JevError(`Respuesta inválida: falta la respuesta del clasificador ${classifier.id}`);
          resolved.set(classifier.id, {
            classifier,
            answer: toAnswer(answer.value, answer.probability, batch.model, batch.usage, answer.extra),
            source: "JEV",
            note: null,
          });
        }
      }

      const classifierResults: ClassifierResult[] = [];
      let baseClassification: Classification | null = null;
      let baseSource: Source = "JEV";

      for (const classifier of classifiers) {
        const item = resolved.get(classifier.id);
        if (!item?.answer) throw new JevError(`Sin respuesta para el clasificador ${classifier.id}`);
        if (item.source === "JEV") saveAnswer(classifier, email.id, email.from, item.answer, "JEV");
        origin[item.source] += 1;
        classifierResults.push({
          classifierId: classifier.id,
          classifierName: classifier.name,
          type: classifier.type,
          version: classifier.version,
          criteria: classifier.criteria,
          value: item.answer.value,
          probability: item.answer.probability,
          extra: item.answer.extra ?? null,
          source: item.source,
          model: item.answer.model,
          note: item.note,
        });
        if (classifier.id === BASE_CLASSIFIER_ID) {
          baseClassification = answerToClassification(classifier, item.answer);
          if (batchModel && item.source === "JEV") baseClassification.model = batchModel;
          baseSource = item.source;
        }
      }

      if (!baseClassification) {
        throw new JevError("El clasificador base no está activo; el formato de results.json lo requiere");
      }

      results.push({
        id: email.id,
        subject: email.subject,
        status: "ok",
        classification: baseClassification,
        source: baseSource,
        classifiers: classifierResults,
      });
      const elapsed = Date.now() - emailStartedAt;
      const custom = classifierResults
        .filter((item) => item.classifierId !== BASE_CLASSIFIER_ID)
        .map((item) => `${item.classifierId}=${item.value}(${percent(item.probability)})[${item.source}]`)
        .join(" ");
      if (log) {
        console.log(
          `${label}  ${baseClassification.category} (${percent(baseClassification.categoryConfidence)})` +
            `  spam ${percent(baseClassification.spamProbability)}` +
            `  atención ${percent(baseClassification.needsAttentionProbability)}` +
            `  [${baseSource}]${custom ? `  ${custom}` : ""}  ${elapsed} ms`,
        );
      }
    } catch (error) {
      const { message, httpStatus } = errorMessage(error);
      results.push({ id: email.id, subject: email.subject, status: "error", error: message, httpStatus });
      if (log) console.error(`${label}  ERROR${httpStatus ? ` (HTTP ${httpStatus})` : ""}: ${message}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  const succeeded = results.filter((result) => result.status === "ok").length;
  const failed = results.length - succeeded;

  return {
    model,
    results,
    summary: {
      emails: emails.length,
      succeeded,
      failed,
      calls: results.length,
      jevCalls,
      bySource: origin,
      avoidedCalls: origin.RULE + origin.CACHE,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  };
}

async function main(): Promise<void> {
  let emails: Email[];
  try {
    emails = parseEmails(await readFile("emails.json", "utf8"));
  } catch (error) {
    console.error(`No se pudo leer emails.json: ${errorMessage(error).message}`);
    process.exitCode = 1;
    return;
  }

  let run: ClassifyRun;
  try {
    run = await classifyEmails(emails, { log: true });
  } catch (error) {
    console.error(errorMessage(error).message);
    process.exitCode = 1;
    closeDb();
    return;
  }

  const { model, results, summary } = run;
  await writeFile(
    "results.json",
    `${JSON.stringify({ generatedAt: new Date().toISOString(), model, summary, results }, null, 2)}\n`,
    "utf8",
  );

  console.log(`\n${"-".repeat(60)}`);
  console.log(`Éxitos: ${summary.succeeded}  Errores: ${summary.failed}  Correos: ${summary.calls}`);
  console.log(
    `Origen (decisiones): JEV ${summary.bySource.JEV}  regla ${summary.bySource.RULE}  caché ${summary.bySource.CACHE}` +
      `  ·  llamadas a Jev: ${summary.jevCalls}  decisiones evitadas: ${summary.avoidedCalls}`,
  );
  console.log(`Duración: ${summary.durationMs} ms`);
  console.log(
    `Tokens: entrada ${summary.inputTokens}  salida ${summary.outputTokens}  total ${summary.inputTokens + summary.outputTokens}`,
  );
  console.log("Resultados guardados en results.json");

  if (summary.failed > 0) process.exitCode = 1;
  closeDb();
}

/** Solo ejecuta el CLI cuando se invoca el archivo directamente (permite importar classifyEmails). */
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Fallo inesperado: ${errorMessage(error).message}`);
    process.exitCode = 1;
  });
}
