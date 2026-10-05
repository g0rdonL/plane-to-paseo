import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: Record<string, unknown> | null;
}

export type Responder = (request: CapturedRequest, response: ServerResponse) => void;

async function readBody(request: IncomingMessage): Promise<CapturedRequest["body"]> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text) as CapturedRequest["body"];
  } catch {
    return null;
  }
}

/** Runs a throwaway HTTP server for one test and tears it down afterwards. */
export async function withHttpServer<T>(
  respond: Responder,
  run: (origin: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const captured: CapturedRequest = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        apiKey: request.headers["x-api-key"] as string | undefined,
        body,
      };
      requests.push(captured);
      respond(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}
