import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  createClassifier,
  createRule,
  listClassifiers,
  listRules,
  setClassifierEnabled,
  setRuleEnabled,
  updateClassifier,
  SPAM_THRESHOLD,
  type Classifier,
  type RuleRow,
} from "./memory.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const REVIEWS_PATH = "data/reviews.json";
const MAX_BODY_BYTES = 10_000;

const VERDICTS = ["correct", "incorrect", "unevaluated"] as const;
const CORRECTIONS = ["PUBLICIDAD", "MANTENER", "REVISAR"] as const;
const CATEGORIES = ["Trabajo", "Personal", "Indeterminado"] as const;

type Verdict = (typeof VERDICTS)[number];
type Correction = (typeof CORRECTIONS)[number];

interface Classification {
  category: string;
  categoryConfidence: number;
  spamProbability: number;
  needsAttentionProbability: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

interface ResultItem {
  id: string;
  subject?: string;
  status: "ok" | "error";
  source?: string;
  classifiers?: ClassifierAnswer[];
  classification?: Classification;
  error?: string;
  httpStatus?: number | null;
}

interface ResultsFile {
  generatedAt?: string;
  model?: string;
  summary?: {
    emails?: number;
    succeeded?: number;
    failed?: number;
    calls?: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    jevCalls?: number;
    avoidedCalls?: number;
    bySource?: Record<string, number>;
  };
  results: ResultItem[];
}

interface EmailItem {
  id: string;
  uid?: number;
  uidValidity?: number;
  messageId?: string | null;
  from?: string;
  subject?: string;
  date?: string;
}

interface StoredReview {
  verdict: Verdict;
  correction: Correction | null;
  updatedAt: string;
}

interface ReviewsFile {
  version: 1;
  reviews: Record<string, StoredReview>;
}

interface ClassifierAnswer {
  classifierId: string;
  classifierName: string;
  type: string;
  value: string;
  probability: number;
  source: string;
  model: string | null;
}

interface DashboardItem {
  key: string;
  origin: string;
  answers: ClassifierAnswer[];
  id: string;
  from: string;
  subject: string;
  date: string | null;
  status: "ok" | "error";
  model: string | null;
  category: string | null;
  confidence: number | null;
  spam: number | null;
  attention: number | null;
  error: string | null;
  verdict: Verdict;
  correction: Correction | null;
  reviewedAt: string | null;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reviewKey(resultId: string, email: EmailItem | undefined, account: string, mailbox: string): string {
  if (email && typeof email.uid === "number" && typeof email.uidValidity === "number") {
    return `${account}|${mailbox}|${email.uidValidity}|${email.uid}`;
  }
  return `${account}|${mailbox}|${resultId}`;
}

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= 320 && /^[A-Za-z0-9@._|:-]+$/.test(key);
}

async function buildData() {
  const results = await readJson<ResultsFile>("results.json");
  const emails = (await readJson<EmailItem[]>("emails.json")) ?? [];
  const reviews = (await readJson<ReviewsFile>(REVIEWS_PATH))?.reviews ?? {};
  const account = process.env.IMAP_USER ?? "local";
  const mailbox = process.env.IMAP_MAILBOX ?? "INBOX";

  const emailById = new Map(emails.filter((email) => typeof email.id === "string").map((email) => [email.id, email]));
  const items: DashboardItem[] = (results?.results ?? []).map((result) => {
    const email = emailById.get(result.id);
    const key = reviewKey(result.id, email, account, mailbox);
    const review = reviews[key];
    const classification = result.status === "ok" ? result.classification : undefined;
    return {
      key,
      origin: result.status === "ok" ? (result.source ?? "JEV") : "ERROR",
      answers: result.classifiers ?? [],
      id: result.id,
      from: email?.from ?? "(desconocido)",
      subject: email?.subject ?? result.subject ?? "(sin asunto)",
      date: email?.date ?? null,
      status: result.status,
      model: classification?.model ?? null,
      category: classification?.category ?? null,
      confidence: classification?.categoryConfidence ?? null,
      spam: classification?.spamProbability ?? null,
      attention: classification?.needsAttentionProbability ?? null,
      error: result.status === "error" ? (result.error ?? "error") : null,
      verdict: review?.verdict ?? "unevaluated",
      correction: review?.correction ?? null,
      reviewedAt: review?.updatedAt ?? null,
    };
  });

  const byCategory: Record<string, number> = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const item of items) {
    if (item.category && item.category in byCategory) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
  }

  const evaluated = items.filter((item) => item.verdict === "correct" || item.verdict === "incorrect");
  const correct = evaluated.filter((item) => item.verdict === "correct").length;
  const incorrect = evaluated.length - correct;
  const labeled = evaluated.filter((item) => item.correction !== null);
  const falsePositives = labeled.filter(
    (item) => (item.spam ?? 0) >= SPAM_THRESHOLD && item.correction !== "PUBLICIDAD",
  ).length;
  const falseNegatives = labeled.filter(
    (item) => (item.spam ?? 0) < SPAM_THRESHOLD && item.correction === "PUBLICIDAD",
  ).length;

  const usageFromItems = (results?.results ?? []).reduce(
    (totals, result) => {
      if (result.status === "ok" && result.classification) {
        totals.input += result.classification.usage?.inputTokens ?? 0;
        totals.output += result.classification.usage?.outputTokens ?? 0;
      }
      return totals;
    },
    { input: 0, output: 0 },
  );
  const usageInput = results?.summary?.inputTokens ?? usageFromItems.input;
  const usageOutput = results?.summary?.outputTokens ?? usageFromItems.output;

  const inputRate = Number(process.env.JEV_INPUT_USD_PER_1M);
  const outputRate = Number(process.env.JEV_OUTPUT_USD_PER_1M);
  const costConfigured =
    Number.isFinite(inputRate) && inputRate >= 0 && Number.isFinite(outputRate) && outputRate >= 0 &&
    process.env.JEV_INPUT_USD_PER_1M !== undefined && process.env.JEV_OUTPUT_USD_PER_1M !== undefined;
  const estimatedCost = costConfigured
    ? (usageInput / 1_000_000) * inputRate + (usageOutput / 1_000_000) * outputRate
    : null;

  const models = [...new Set(items.map((item) => item.model).filter((model): model is string => Boolean(model)))];

  return {
    generatedAt: results?.generatedAt ?? null,
    modelAlias: results?.model ?? null,
    models,
    runtime: { account, mailbox, spamThreshold: SPAM_THRESHOLD, host: HOST, port: PORT },
    classifiers: listClassifiers(),
    rules: listRules(),
    metrics: {
      total: items.length,
      ok: items.filter((item) => item.status === "ok").length,
      errors: items.filter((item) => item.status === "error").length,
      byCategory,
      evaluated: evaluated.length,
      correct,
      incorrect,
      accuracy: evaluated.length > 0 ? correct / evaluated.length : null,
      labeled: labeled.length,
      falsePositives,
      falseNegatives,
      pending: items.length - evaluated.length,
      durationMs: results?.summary?.durationMs ?? null,
      inputTokens: usageInput,
      outputTokens: usageOutput,
      calls: results?.summary?.calls ?? items.length,
      jevCalls: typeof results?.summary?.jevCalls === "number" ? results.summary.jevCalls : null,
      bySource: results?.summary?.bySource ?? null,
      avoidedCalls: typeof results?.summary?.avoidedCalls === "number" ? results.summary.avoidedCalls : null,
    },
    cost: {
      configured: costConfigured,
      inputUsdPer1M: costConfigured ? inputRate : null,
      outputUsdPer1M: costConfigured ? outputRate : null,
      estimatedUsd: estimatedCost,
    },
    items,
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Cuerpo de petición demasiado grande");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

async function saveReview(payload: unknown): Promise<{ key: string; verdict: Verdict; correction: Correction | null }> {
  if (!isRecord(payload) || !validKey(payload.key)) throw new Error("Clave de mensaje inválida");
  const verdict = payload.verdict;
  if (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict)) {
    throw new Error("Veredicto inválido");
  }
  const correction = payload.correction ?? null;
  if (correction !== null && (typeof correction !== "string" || !CORRECTIONS.includes(correction as Correction))) {
    throw new Error("Corrección inválida");
  }

  const data = await buildData();
  if (!data.items.some((item) => item.key === payload.key)) {
    throw new Error("La clave no corresponde a ningún correo del lote actual");
  }

  const current = (await readJson<ReviewsFile>(REVIEWS_PATH)) ?? { version: 1 as const, reviews: {} };
  const reviews = current.reviews;
  const clean = { verdict: verdict as Verdict, correction: correction as Correction | null };

  if (clean.verdict === "unevaluated" && clean.correction === null) {
    delete reviews[payload.key];
  } else {
    reviews[payload.key] = { ...clean, updatedAt: new Date().toISOString() };
  }

  await mkdir("data", { recursive: true });
  const temporary = `${REVIEWS_PATH}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, reviews }, null, 2)}\n`, "utf8");
  await rename(temporary, REVIEWS_PATH);
  return { key: payload.key, ...clean };
}

async function createRuleFromRequest(payload: unknown): Promise<RuleRow> {
  if (!isRecord(payload)) throw new Error("Cuerpo inválido");
  const { type, value, action } = payload;
  if (typeof type !== "string" || typeof value !== "string" || typeof action !== "string") {
    throw new Error("Faltan type, value o action");
  }
  if (!value.trim()) throw new Error("Valor de regla vacío");
  const classifierId = typeof payload.classifierId === "string" && payload.classifierId ? payload.classifierId : "base";
  return createRule({ classifierId, type, value, action });
}

function classifierFromRequest(payload: unknown): Classifier {
  if (!isRecord(payload)) throw new Error("Cuerpo inválido");
  return createClassifier({
    name: String(payload.name ?? ""),
    description: String(payload.description ?? ""),
    question: String(payload.question ?? ""),
    type: String(payload.type ?? ""),
    options: payload.options,
  });
}

function classifierUpdateFromRequest(payload: unknown): Classifier {
  if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
    throw new Error("Falta id de clasificador");
  }
  return updateClassifier(payload.id, {
    name: payload.name !== undefined ? String(payload.name) : undefined,
    description: payload.description !== undefined ? String(payload.description) : undefined,
    question: payload.question !== undefined ? String(payload.question) : undefined,
    type: payload.type !== undefined ? String(payload.type) : undefined,
    options: payload.options,
  });
}

function classifierToggleFromRequest(payload: unknown): Classifier {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.enabled !== "boolean") {
    throw new Error("Faltan id o enabled");
  }
  const updated = setClassifierEnabled(payload.id, payload.enabled);
  if (!updated) throw new Error("Clasificador no encontrado");
  return updated;
}

function toggleRule(payload: unknown): RuleRow {
  if (!isRecord(payload) || typeof payload.id !== "number") throw new Error("Falta id de regla");
  if (typeof payload.enabled !== "boolean") throw new Error("Falta enabled");
  const updated = setRuleEnabled(payload.id, payload.enabled);
  if (!updated) throw new Error("Regla no encontrada");
  return updated;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Mail · Observabilidad</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --muted: #888; }
  * { box-sizing: border-box; }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta, .muted { color: var(--muted); font-size: 12px; }
  .metrics { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
  .metric { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; min-width: 130px; }
  .metric b { display: block; font-size: 18px; }
  .metric span { color: var(--muted); font-size: 12px; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { position: sticky; top: 0; background: Canvas; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  td.subject { max-width: 340px; overflow-wrap: anywhere; }
  .pill { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
  .error { color: #c0392b; }
  .ok { color: #1e8449; }
  .controls { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  button { font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; cursor: pointer; }
  button[aria-pressed="true"] { background: #0b62d6; border-color: #0b62d6; color: #fff; }
  select { font: inherit; font-size: 12px; padding: 3px 4px; border-radius: 6px; border: 1px solid var(--line); background: transparent; }
  .bar { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .bar button { padding: 6px 12px; }
  .rules { margin: 16px 0; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
  .rules h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; color: var(--muted); }
  .rules form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
  .rules input, .rules select { font: inherit; font-size: 12px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }
  .rules input { min-width: 220px; }
  .rules table { font-size: 12px; }
  .rules td, .rules th { padding: 4px 8px; }
  .off { opacity: .5; text-decoration: line-through; }
  tr.reviewed td { background: color-mix(in srgb, Canvas 92%, #0b62d6 8%); }
</style>
</head>
<body>
<h1>Jev Mail · Observabilidad</h1>
<div class="meta" id="meta">Cargando…</div>
<div class="bar"><button id="refresh" type="button">Recargar datos</button><span class="muted" id="status"></span></div>
<section class="metrics" id="metrics" aria-label="Métricas"></section>
<section class="rules">
  <h2>Clasificadores</h2>
  <form id="classifier-form">
    <input id="cf-name" name="name" placeholder="Nombre (p. ej. OTP)" autocomplete="off" required>
    <select name="type" id="cf-type" aria-label="Tipo de clasificador">
      <option value="choice">choice</option>
      <option value="noul">noul</option>
    </select>
    <input id="cf-question" name="question" placeholder="Pregunta o afirmación a evaluar" autocomplete="off" required>
    <input id="cf-options" name="options" placeholder="Opciones separadas por coma (solo choice)" autocomplete="off">
    <input id="cf-description" name="description" placeholder="Descripción (opcional)" autocomplete="off">
    <button type="submit" id="cf-submit">Crear clasificador</button>
    <button type="button" id="cf-cancel" hidden>Cancelar edición</button>
    <span class="muted" id="cf-editing"></span>
  </form>
  <div class="table-wrap">
    <table>
      <thead><tr><th>ID</th><th>Nombre</th><th>Tipo</th><th>Pregunta</th><th>Opciones</th><th>Versión</th><th>Estado</th><th></th></tr></thead>
      <tbody id="classifier-rows"></tbody>
    </table>
  </div>
</section>
<section class="rules">
  <h2>Reglas de remitente</h2>
  <form id="rule-form">
    <select name="classifierId" id="rule-classifier" aria-label="Clasificador de la regla"></select>
    <select name="type" id="rule-type" aria-label="Tipo de regla">
      <option value="DOMAIN">DOMAIN</option>
      <option value="EMAIL">EMAIL</option>
    </select>
    <input id="rule-value" name="value" placeholder="dominio.com o persona@dominio.com" autocomplete="off">
    <select name="action" id="rule-action" aria-label="Acción de la regla"></select>
    <button type="submit">Añadir regla</button>
  </form>
  <div class="table-wrap">
    <table>
      <thead><tr><th>ID</th><th>Clasificador</th><th>Tipo</th><th>Valor</th><th>Acción</th><th>Origen</th><th>Estado</th><th></th></tr></thead>
      <tbody id="rule-rows"></tbody>
    </table>
  </div>
</section>
<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Remitente</th><th>Asunto</th><th>Fecha</th><th>Categoría</th><th>Conf.</th>
        <th>Spam</th><th>Atención</th><th>Otros clasificadores</th><th>Estado</th><th>Origen</th><th>Modelo</th><th>Evaluación</th><th>Corrección</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<script>
(function () {
  var VERDICT_LABELS = [["correct", "Correcta"], ["incorrect", "Incorrecta"], ["unevaluated", "Sin evaluar"]];
  var CORRECTIONS = ["PUBLICIDAD", "MANTENER", "REVISAR"];
  var classifiersCache = [];
  var editingId = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function pct(value) {
    return value === null || value === undefined ? "—" : (value * 100).toFixed(1) + " %";
  }

  function metric(label, value, hint) {
    var box = el("div", "metric");
    box.appendChild(el("span", null, label));
    box.appendChild(el("b", null, value));
    if (hint) box.appendChild(el("span", null, hint));
    return box;
  }

  function actionsFor(classifier) {
    if (classifier.type === "base") return ["PUBLICIDAD", "MANTENER"];
    if (classifier.type === "noul") return ["sí", "no"];
    return classifier.options;
  }

  function renderClassifiers(data) {
    classifiersCache = data.classifiers;
    var body = document.getElementById("classifier-rows");
    body.replaceChildren();
    data.classifiers.forEach(function (classifier) {
      var row = el("tr");
      if (!classifier.enabled) row.className = "off";
      row.appendChild(el("td", null, classifier.id));
      row.appendChild(el("td", null, classifier.name));
      row.appendChild(el("td", null, classifier.type));
      row.appendChild(el("td", "subject", classifier.question));
      row.appendChild(el("td", "muted", classifier.type === "base" ? "categoría + spam + atención" : classifier.options.join(", ")));
      row.appendChild(el("td", null, "v" + classifier.version));
      row.appendChild(el("td", null, classifier.enabled ? "activo" : "desactivado"));
      var actions = el("td");
      if (classifier.type !== "base") {
        var edit = el("button", null, "Editar");
        edit.type = "button";
        edit.addEventListener("click", function () { startEdit(classifier); });
        actions.appendChild(edit);
      }
      var toggle = el("button", null, classifier.enabled ? "Desactivar" : "Activar");
      toggle.type = "button";
      if (classifier.type === "base") toggle.disabled = true;
      toggle.addEventListener("click", function () {
        toggleClassifier(classifier.id, !classifier.enabled);
      });
      actions.appendChild(toggle);
      row.appendChild(actions);
      body.appendChild(row);
    });

    var select = document.getElementById("rule-classifier");
    var previous = select.value;
    select.replaceChildren();
    data.classifiers.forEach(function (classifier) {
      var option = el("option", null, classifier.name + " (" + classifier.id + ")");
      option.value = classifier.id;
      select.appendChild(option);
    });
    if (previous) select.value = previous;
    renderActionOptions();
  }

  function renderActionOptions() {
    var select = document.getElementById("rule-classifier");
    var classifier = classifiersCache.filter(function (c) { return c.id === select.value; })[0] || classifiersCache[0];
    var action = document.getElementById("rule-action");
    var previous = action.value;
    action.replaceChildren();
    if (!classifier) return;
    actionsFor(classifier).forEach(function (name) {
      var option = el("option", null, name);
      option.value = name;
      action.appendChild(option);
    });
    if (previous) action.value = previous;
  }

  function startEdit(classifier) {
    editingId = classifier.id;
    document.getElementById("cf-name").value = classifier.name;
    document.getElementById("cf-type").value = classifier.type;
    document.getElementById("cf-question").value = classifier.question;
    document.getElementById("cf-options").value = classifier.options.join(", ");
    document.getElementById("cf-description").value = classifier.description || "";
    document.getElementById("cf-submit").textContent = "Guardar cambios";
    document.getElementById("cf-cancel").hidden = false;
    document.getElementById("cf-editing").textContent = "Editando " + classifier.id + " (cambiar semántica sube la versión e invalida su caché)";
    window.scrollTo(0, 0);
  }

  function resetForm() {
    editingId = null;
    document.getElementById("classifier-form").reset();
    document.getElementById("cf-submit").textContent = "Crear clasificador";
    document.getElementById("cf-cancel").hidden = true;
    document.getElementById("cf-editing").textContent = "";
  }

  function renderRules(data) {
    var body = document.getElementById("rule-rows");
    body.replaceChildren();
    if (!data.rules.length) {
      var empty = el("tr");
      var cell = el("td", "muted", "Sin reglas. Las clasificaciones de Jev no crean reglas automáticamente.");
      cell.colSpan = 8;
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }
    data.rules.forEach(function (rule) {
      var row = el("tr");
      if (!rule.enabled) row.className = "off";
      row.appendChild(el("td", null, rule.id));
      row.appendChild(el("td", null, rule.classifier_id));
      row.appendChild(el("td", null, rule.type));
      row.appendChild(el("td", null, rule.value));
      row.appendChild(el("td", null, rule.action));
      row.appendChild(el("td", "muted", rule.origin));
      row.appendChild(el("td", null, rule.enabled ? "activa" : "desactivada"));
      var actions = el("td");
      var button = el("button", null, rule.enabled ? "Desactivar" : "Activar");
      button.type = "button";
      button.addEventListener("click", function () {
        toggleRule(rule.id, !rule.enabled);
      });
      actions.appendChild(button);
      row.appendChild(actions);
      body.appendChild(row);
    });
  }

  function renderMetrics(data) {
    var host = document.getElementById("metrics");
    host.replaceChildren();
    var m = data.metrics;
    if (m.bySource) {
      host.appendChild(metric("Llamadas Jev", m.jevCalls === null ? "—" : m.jevCalls, "de " + m.total + " correos"));
      host.appendChild(metric("Por regla", m.bySource.RULE || 0, "decisiones resueltas con regla"));
      host.appendChild(metric("Por caché", m.bySource.CACHE || 0, "clasificación previa del mismo mensaje"));
      host.appendChild(metric("Llamadas evitadas", m.avoidedCalls === null ? "—" : m.avoidedCalls, "regla + caché"));
    }
    host.appendChild(metric("Correos", m.total, m.ok + " ok · " + m.errors + " errores"));
    host.appendChild(metric("Evaluados", m.evaluated, m.pending + " sin evaluar"));
    host.appendChild(metric("Aciertos", m.correct + " / " + m.evaluated, m.accuracy === null ? "sin datos" : pct(m.accuracy)));
    host.appendChild(metric("Falsos positivos", m.falsePositives, "sobre " + m.labeled + " con corrección · spam ≥ " + pct(data.runtime.spamThreshold)));
    host.appendChild(metric("Falsos negativos", m.falseNegatives, "sobre " + m.labeled + " con corrección"));
    host.appendChild(metric("Duración", m.durationMs === null ? "—" : (m.durationMs / 1000).toFixed(1) + " s", m.calls + " llamadas"));
    host.appendChild(metric("Tokens", (m.inputTokens + m.outputTokens).toLocaleString("es-ES"), m.inputTokens + " entrada · " + m.outputTokens + " salida"));
    host.appendChild(metric("Costo estimado", data.cost.configured ? data.cost.estimatedUsd.toFixed(6) + " USD" : "—",
      data.cost.configured ? data.cost.inputUsdPer1M + " / " + data.cost.outputUsdPer1M + " USD por 1M tokens" : "tarifa no configurada"));
    Object.keys(m.byCategory).forEach(function (category) {
      host.appendChild(metric(category, m.byCategory[category], "clasificados"));
    });
  }

  function renderControls(cell, item) {
    var wrap = el("div", "controls");
    VERDICT_LABELS.forEach(function (pair) {
      var button = el("button", null, pair[1]);
      button.type = "button";
      button.setAttribute("aria-pressed", item.verdict === pair[0] ? "true" : "false");
      button.addEventListener("click", function () {
        save(item.key, pair[0], item.correction);
      });
      wrap.appendChild(button);
    });
    var select = el("select");
    select.name = "correction";
    select.setAttribute("aria-label", "Corrección humana");
    var empty = el("option", null, "—");
    empty.value = "";
    select.appendChild(empty);
    CORRECTIONS.forEach(function (correction) {
      var option = el("option", null, correction);
      option.value = correction;
      if (item.correction === correction) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", function () {
      save(item.key, item.verdict, select.value || null);
    });
    wrap.appendChild(select);
    cell.appendChild(wrap);
  }

  function renderRows(data) {
    var body = document.getElementById("rows");
    body.replaceChildren();
    if (data.items.length === 0) {
      var empty = el("tr");
      var cell = el("td", "muted", "No hay resultados. Ejecuta npm run classify.");
      cell.colSpan = 13;
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }
    data.items.forEach(function (item) {
      var row = el("tr");
      if (item.verdict !== "unevaluated" || item.correction) row.className = "reviewed";
      row.appendChild(el("td", null, item.from));
      row.appendChild(el("td", "subject", item.subject));
      row.appendChild(el("td", "muted", item.date ? new Date(item.date).toLocaleString("es-ES") : "—"));
      row.appendChild(el("td", null, item.status === "ok" ? (item.category || "—") : "—"));
      row.appendChild(el("td", null, item.status === "ok" ? pct(item.confidence) : "—"));
      row.appendChild(el("td", null, item.status === "ok" ? pct(item.spam) : "—"));
      row.appendChild(el("td", null, item.status === "ok" ? pct(item.attention) : "—"));
      var extras = el("td", "muted");
      (item.answers || []).forEach(function (answer) {
        if (answer.classifierId === "base") return;
        var chip = el("span", "pill", answer.classifierName + ": " + answer.value + " " + pct(answer.probability) + " [" + answer.source + "]");
        chip.style.margin = "0 4px 2px 0";
        chip.style.display = "inline-block";
        extras.appendChild(chip);
      });
      row.appendChild(extras);
      var status = el("td", item.status === "ok" ? "ok" : "error");
      var pill = el("span", "pill", item.status === "ok" ? "ok" : "error");
      status.appendChild(pill);
      if (item.error) status.appendChild(el("div", "muted", item.error));
      row.appendChild(status);
      row.appendChild(el("td", null, item.origin));
      row.appendChild(el("td", "muted", item.model || "—"));
      var controls = el("td");
      renderControls(controls, item);
      row.appendChild(controls);
      body.appendChild(row);
    });
  }

  function render(data) {
    document.getElementById("meta").textContent =
      (data.modelAlias ? "modelo " + data.modelAlias : "modelo desconocido") +
      (data.models.length ? " → " + data.models.join(", ") : "") +
      " · lote " + (data.generatedAt ? new Date(data.generatedAt).toLocaleString("es-ES") : "sin fecha") +
      " · " + data.runtime.account + " / " + data.runtime.mailbox +
      " · " + "http://" + data.runtime.host + ":" + data.runtime.port;
    renderMetrics(data);
    renderClassifiers(data);
    renderRules(data);
    renderRows(data);
  }

  function setStatus(text, isError) {
    var status = document.getElementById("status");
    status.textContent = text;
    status.className = isError ? "error" : "muted";
  }

  function load() {
    return fetch("/api/data", { cache: "no-store" })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data.error) throw new Error(data.error);
        render(data);
      })
      .catch(function (error) { setStatus("Error cargando datos: " + error.message, true); });
  }

  function save(key, verdict, correction) {
    setStatus("Guardando…", false);
    fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key, verdict: verdict, correction: correction }),
    })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) throw new Error(payload.error || response.status);
          return payload;
        });
      })
      .then(function () { setStatus("Evaluación guardada", false); return load(); })
      .catch(function (error) { setStatus("No se pudo guardar: " + error.message, true); });
  }

  function post(url, payload, done) {
    setStatus("Guardando…", false);
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data.error || response.status);
          return data;
        });
      })
      .then(function () { setStatus(done, false); return load(); })
      .catch(function (error) { setStatus("No se pudo guardar: " + error.message, true); });
  }

  function toggleRule(id, enabled) {
    post("/api/rules/toggle", { id: id, enabled: enabled }, enabled ? "Regla activada" : "Regla desactivada");
  }

  document.getElementById("rule-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var value = document.getElementById("rule-value").value.trim();
    if (!value) { setStatus("Introduce un dominio o una dirección", true); return; }
    post("/api/rules", {
      classifierId: document.getElementById("rule-classifier").value,
      type: document.getElementById("rule-type").value,
      action: document.getElementById("rule-action").value,
      value: value,
    }, "Regla creada");
  });

  document.getElementById("rule-classifier").addEventListener("change", renderActionOptions);

  function toggleClassifier(id, enabled) {
    post("/api/classifiers/toggle", { id: id, enabled: enabled }, enabled ? "Clasificador activado" : "Clasificador desactivado");
  }

  document.getElementById("cf-cancel").addEventListener("click", resetForm);

  document.getElementById("classifier-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var payload = {
      name: document.getElementById("cf-name").value.trim(),
      type: document.getElementById("cf-type").value,
      question: document.getElementById("cf-question").value.trim(),
      options: document.getElementById("cf-options").value,
      description: document.getElementById("cf-description").value.trim(),
    };
    if (!payload.name || !payload.question) { setStatus("Nombre y pregunta son obligatorios", true); return; }
    if (editingId) {
      payload.id = editingId;
      post("/api/classifiers/update", payload, "Clasificador actualizado");
      resetForm();
    } else {
      post("/api/classifiers", payload, "Clasificador creado");
      resetForm();
    }
  });

  document.getElementById("cf-type").addEventListener("change", function () {
    document.getElementById("cf-options").disabled = this.value === "noul";
  });

  document.getElementById("refresh").addEventListener("click", function () { load(); });
  load();
})();
</script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      });
      response.end(PAGE);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/data") {
      sendJson(response, 200, await buildData());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/classifiers") {
      sendJson(response, 201, { ok: true, classifier: classifierFromRequest(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/classifiers/update") {
      sendJson(response, 200, { ok: true, classifier: classifierUpdateFromRequest(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/classifiers/toggle") {
      sendJson(response, 200, { ok: true, classifier: classifierToggleFromRequest(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rules") {
      sendJson(response, 201, { ok: true, rule: await createRuleFromRequest(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/rules/toggle") {
      sendJson(response, 200, { ok: true, rule: toggleRule(await readBody(request)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/reviews") {
      const saved = await saveReview(await readBody(request));
      sendJson(response, 200, { ok: true, ...saved });
      return;
    }
    sendJson(response, 404, { error: "No encontrado" });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Panel local: http://${HOST}:${PORT}`);
  console.log(`Evaluaciones: ${REVIEWS_PATH} · umbral spam: ${SPAM_THRESHOLD} · solo escucha en ${HOST}`);
});
