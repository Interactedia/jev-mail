import { writeFile } from "node:fs/promises";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { decodeWords } from "postal-mime";

const MAX_MESSAGES = 20;
const MAX_BODY_CHARS = 10_000;

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

export interface TextPart {
  part: string;
  html: boolean;
}

export function readConfig(): ImapConfig {
  const missing = ["IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}. Revisa .env.example`);
  }
  const port = Number(process.env.IMAP_PORT ?? 993);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("IMAP_PORT inválido");
  }
  return {
    host: process.env.IMAP_HOST as string,
    port,
    user: process.env.IMAP_USER as string,
    password: process.env.IMAP_PASSWORD as string,
    mailbox: process.env.IMAP_MAILBOX || "INBOX",
  };
}

function isAttachment(node: MessageStructureObject): boolean {
  return (node.disposition ?? "").toLowerCase() === "attachment";
}

export function findTextPart(node: MessageStructureObject | undefined): TextPart | undefined {
  if (!node || isAttachment(node)) return undefined;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const plain = findPlainPart(child);
      if (plain) return plain;
    }
    for (const child of node.childNodes) {
      const html = findHtmlPart(child);
      if (html) return html;
    }
    return undefined;
  }
  if (node.type === "text/plain") return { part: node.part ?? "1", html: false };
  if (node.type === "text/html") return { part: node.part ?? "1", html: true };
  return undefined;
}

function findPlainPart(node: MessageStructureObject): TextPart | undefined {
  if (isAttachment(node)) return undefined;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = findPlainPart(child);
      if (found) return found;
    }
    return undefined;
  }
  return node.type === "text/plain" ? { part: node.part ?? "1", html: false } : undefined;
}

function findHtmlPart(node: MessageStructureObject): TextPart | undefined {
  if (isAttachment(node)) return undefined;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = findHtmlPart(child);
      if (found) return found;
    }
    return undefined;
  }
  return node.type === "text/html" ? { part: node.part ?? "1", html: true } : undefined;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const responseText = (error as Error & { responseText?: string }).responseText;
    return responseText ? `${error.message}: ${responseText}` : error.message;
  }
  return String(error);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
}

export function sender(envelope: FetchMessageObject["envelope"]): string {
  const address = envelope?.from?.[0];
  if (!address) return "desconocido";
  const name = address.name ? decodeWords(address.name) : "";
  return name && address.address ? `${name} <${address.address}>` : (address.address ?? name ?? "desconocido");
}

export async function downloadText(
  client: ImapFlow,
  uid: number,
  textPart: TextPart,
): Promise<string> {
  const result = await client.download(String(uid), textPart.part, { uid: true, maxBytes: 512 * 1024 });
  if (!("content" in result) || !result.content) {
    throw new Error(`No se pudo descargar la parte ${textPart.part}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of result.content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const text = textPart.html ? htmlToText(raw) : decodeEntities(raw);
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, MAX_BODY_CHARS)
    .trim();
}

export interface OpenMailbox {
  client: ImapFlow;
  exists: number;
  uidValidity: number;
  highestUid: number;
  release: () => Promise<void>;
  close: () => Promise<void>;
}

/** Abre la carpeta con lock readOnly. highestUid = uidNext - 1 (UID más alto asignado). */
export async function openMailbox(config: ImapConfig): Promise<OpenMailbox> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
  await client.connect();
  let lock;
  try {
    lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
  } catch (error) {
    await client.logout().catch(() => undefined);
    throw error;
  }
  const mailbox = client.mailbox;
  if (!mailbox) {
    lock.release();
    await client.logout().catch(() => undefined);
    throw new Error("El servidor no devolvió información de la carpeta");
  }
  const uidValidity = Number(mailbox.uidValidity);
  const highestUid = Math.max(0, Number(mailbox.uidNext ?? 1) - 1);
  return {
    client,
    exists: mailbox.exists,
    uidValidity,
    highestUid,
    release: async () => {
      lock?.release();
    },
    close: async () => {
      await client.logout().catch(() => undefined);
    },
  };
}

/** Instantánea de flags de un rango, para verificar que no modificamos el buzón. */
export async function flagsSnapshot(
  client: ImapFlow,
  range: string,
  options: { uid?: boolean } = {},
): Promise<Map<number, string>> {
  const fetched = await client.fetchAll(range, { uid: true, flags: true }, options);
  return new Map(fetched.map((message) => [message.uid, [...(message.flags ?? [])].sort().join(",")]));
}

export function countChangedFlags(before: Map<number, string>, after: Map<number, string>): number {
  let changed = 0;
  for (const [uid, flags] of before) {
    const now = after.get(uid);
    if (now !== undefined && now !== flags) changed += 1;
  }
  return changed;
}

async function main(): Promise<void> {
  let config: ImapConfig;
  try {
    config = readConfig();
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
    return;
  }

  let opened: OpenMailbox | undefined;
  try {
    opened = await openMailbox(config);
    const { client } = opened;
    {
      const exists = opened.exists;
      if (!exists) {
        throw new Error("La carpeta no contiene mensajes");
      }
      const uidValidity = opened.uidValidity;
      console.log(`Conectado a ${config.host}:${config.port} · ${config.mailbox} (readOnly)`);
      console.log(`Mensajes en la carpeta: ${exists} · UIDVALIDITY: ${uidValidity}`);

      const count = Math.min(MAX_MESSAGES, exists);
      const from = exists - count + 1;
      const messages = await client.fetchAll(`${from}:*`, {
        uid: true,
        envelope: true,
        bodyStructure: true,
        internalDate: true,
        flags: true,
      });
      const flagsBefore = new Map(
        messages.map((message) => [message.uid, [...(message.flags ?? [])].sort().join(",")]),
      );

      const emails: Record<string, unknown>[] = [];
      for (const message of messages) {
        const textPart = findTextPart(message.bodyStructure);
        if (!textPart) {
          console.warn(`UID ${message.uid}: sin parte de texto, se omite`);
          continue;
        }
        let body: string;
        try {
          body = await downloadText(client, message.uid, textPart);
        } catch (error) {
          console.warn(`UID ${message.uid}: ${errorText(error)}, se omite`);
          continue;
        }
        if (!body) {
          console.warn(`UID ${message.uid}: cuerpo vacío, se omite`);
          continue;
        }
        const envelope = message.envelope;
        emails.push({
          id: `imap-${uidValidity}-${message.uid}`,
          uid: message.uid,
          uidValidity,
          messageId: envelope?.messageId ? envelope.messageId.replace(/^<|>$/g, "") : null,
          from: sender(envelope),
          subject: envelope?.subject ? decodeWords(envelope.subject) : "(sin asunto)",
          date: new Date(message.internalDate ?? Date.now()).toISOString(),
          body,
        });
      }

      if (emails.length === 0) {
        throw new Error("No se pudo normalizar ningún mensaje; emails.json no se modificó");
      }

      const after = await client.fetchAll(`${from}:*`, { uid: true, flags: true });
      const flagsChanged = after.filter((message) => {
        const before = flagsBefore.get(message.uid);
        return before !== undefined && before !== [...(message.flags ?? [])].sort().join(",");
      });

      await writeFile("emails.json", `${JSON.stringify(emails, null, 2)}\n`, "utf8");

      console.log(`\n${emails.length} mensajes guardados en emails.json (máximo ${MAX_MESSAGES})`);
      console.log(`Flags modificados: ${flagsChanged.length}`);
      if (flagsChanged.length > 0) {
        console.error("ALERTA: cambiaron flags de lectura en el servidor");
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(`Error IMAP: ${errorText(error)}`);
    console.error("emails.json no se modificó");
    process.exitCode = 1;
  } finally {
    if (opened) {
      await opened.release();
      await opened.close();
    }
  }
}

/** Solo ejecuta el flujo cuando se invoca el archivo directamente (permite importar los helpers). */
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Fallo inesperado: ${errorText(error)}`);
    process.exitCode = 1;
  });
}
