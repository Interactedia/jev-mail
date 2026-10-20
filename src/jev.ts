import type { Classifier } from "./memory.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const CATEGORIES = ["Trabajo", "Personal", "Indeterminado"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Contrato legado del clasificador base; se conserva para results.json y el dashboard. */
export interface Classification {
  category: Category;
  categoryConfidence: number;
  spamProbability: number;
  needsAttentionProbability: number;
  model: string;
  usage: Usage;
}

/** Pregunta Jev construida a partir de un clasificador configurable. */
export interface JevQuestion {
  classifier: Classifier;
  name: string;
  question: Record<string, unknown>;
}

export interface JevBatchResult {
  model: string;
  usage: Usage;
  answers: Map<string, { value: string; probability: number; extra?: Record<string, number> }>;
}

export class JevError extends Error {
  readonly httpStatus: number | undefined;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "JevError";
    this.httpStatus = httpStatus;
  }
}

const NOUL_YES = "sí";
const NOUL_NO = "no";

export function baseQuestions(): JevQuestion[] {
  const base = { id: "base", type: "base" } as Classifier;
  return [
    {
      classifier: base,
      name: "category",
      question: {
        type: "choice",
        instructions: "Clasifica el correo según su propósito principal.",
        criteria: {
          Trabajo: "Correo laboral, profesional, comercial o de una organización",
          Personal: "Correo personal, familiar o social",
          Indeterminado: "No hay información suficiente para decidir",
        },
      },
    },
    {
      classifier: base,
      name: "spam",
      question: {
        type: "noul",
        instructions: "¿Es spam, phishing, publicidad no solicitada o un intento de fraude?",
      },
    },
    {
      classifier: base,
      name: "needsAttention",
      question: {
        type: "noul",
        instructions: "¿Requiere una acción o respuesta del destinatario en las próximas 48 horas?",
      },
    },
  ];
}

/** Una pregunta Jev por clasificador configurable; los nombres se responden igual que se envían. */
export function questionFor(classifier: Classifier): JevQuestion {
  if (classifier.type === "noul") {
    return {
      classifier,
      name: classifier.id,
      question: { type: "noul", instructions: classifier.question },
    };
  }
  const criteria: Record<string, string> = {};
  for (const option of classifier.options) criteria[option] = option;
  return {
    classifier,
    name: classifier.id,
    question: { type: "choice", instructions: classifier.question, criteria },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevError(`Respuesta inválida: ${field} no es una probabilidad entre 0 y 1`);
  }
  return value;
}

function readUsage(payload: Record<string, unknown>): Usage {
  const usage = isRecord(payload.usage) ? payload.usage : {};
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

function errorMessage(payload: unknown, status: number): string {
  const detail = isRecord(payload) && isRecord(payload.detail) ? payload.detail.message : undefined;
  return typeof detail === "string" ? detail : `Error HTTP ${status}`;
}

/** Una sola petición conjunta con las preguntas base + las de los clasificadores activos. */
export async function classifyWithJev(
  email: Email,
  questions: JevQuestion[],
  apiKey: string,
  model = "jev-latest",
  timeoutMs = 60_000,
): Promise<JevBatchResult> {
  if (questions.length === 0) throw new JevError("No hay preguntas que enviar a Jev");

  const payloadQuestions: Record<string, unknown> = {};
  for (const item of questions) payloadQuestions[item.name] = item.question;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      state: `De: ${email.from}\nAsunto: ${email.subject}\n\n${email.body}`,
      questions: payloadQuestions,
    }),
  });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new JevError(`Respuesta no JSON (HTTP ${response.status})`, response.status);
  }
  if (!response.ok) {
    throw new JevError(errorMessage(payload, response.status), response.status);
  }
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new JevError("Respuesta inválida: falta 'answers'");
  }

  const answers = new Map<string, { value: string; probability: number; extra?: Record<string, number> }>();
  for (const item of questions) {
    const answer = payload.answers[item.name];
    if (!isRecord(answer)) {
      throw new JevError(`Respuesta inválida: falta la respuesta '${item.name}'`);
    }
    if (item.question.type === "noul") {
      if (answer.type !== "noul") throw new JevError(`Respuesta inválida: '${item.name}' no es noul`);
      const noul = probability(answer.noul, `${item.name}.noul`);
      answers.set(item.name, { value: noul >= 0.5 ? NOUL_YES : NOUL_NO, probability: noul });
    } else {
      if (answer.type !== "choice") throw new JevError(`Respuesta inválida: '${item.name}' no es choice`);
      if (typeof answer.choice !== "string") throw new JevError(`Respuesta inválida: '${item.name}' sin choice`);
      answers.set(item.name, {
        value: answer.choice,
        probability: probability(answer.confidence, `${item.name}.confidence`),
      });
    }
  }

  return {
    model: typeof payload.model === "string" ? payload.model : model,
    usage: readUsage(payload),
    answers,
  };
}

function baseAnswer(result: JevBatchResult): Classification {
  const category = result.answers.get("category");
  const spam = result.answers.get("spam");
  const attention = result.answers.get("needsAttention");
  if (!category || !spam || !attention) {
    throw new JevError("Respuesta inválida: faltan respuestas del clasificador base");
  }
  if (!CATEGORIES.includes(category.value as Category)) {
    throw new JevError(`Respuesta inválida: categoría fuera del contrato (${category.value})`);
  }
  return {
    category: category.value as Category,
    categoryConfidence: category.probability,
    spamProbability: spam.probability,
    needsAttentionProbability: attention.probability,
    model: result.model,
    usage: result.usage,
  };
}

/** Compatibilidad con MVP-01..05: una petición con las tres preguntas base. */
export async function classifyEmail(
  email: Email,
  apiKey: string,
  model = "jev-latest",
  timeoutMs = 60_000,
): Promise<Classification> {
  return baseAnswer(await classifyWithJev(email, baseQuestions(), apiKey, model, timeoutMs));
}

export { baseAnswer };
