import type { IncomingMessage, ServerResponse } from 'node:http';

/** An error whose message is safe and useful to show in the app. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const FS_ERRORS: Record<string, [number, string]> = {
  ENOENT: [404, 'Not found'],
  EEXIST: [409, 'Something with that name already exists'],
  ENOTEMPTY: [409, 'The folder is not empty'],
  EBUSY: [409, 'It is in use by another program'],
  EPERM: [403, 'Permission denied (or it is in use by another program)'],
  EACCES: [403, 'Permission denied'],
  ENOTDIR: [400, 'Not a folder'],
  EISDIR: [400, 'That is a folder'],
  EINVAL: [400, 'Invalid operation'],
};

/** Maps HttpErrors and common file system errors to a status and message; undefined for bugs. */
export function toHttpError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return err;
  const known = FS_ERRORS[(err as NodeJS.ErrnoException)?.code ?? ''];
  return known && new HttpError(...known);
}

/** The request body, or null if it is larger than `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] ?? 0) > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const body = await readBody(req, limit);
  if (!body) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The request's JSON object body; 400 for anything else. */
export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body as Record<string, unknown>;
}

export function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
