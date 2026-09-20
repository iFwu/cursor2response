import { expect, test } from "vitest";
import { once } from "node:events";
import { request } from "node:http";
import { createSidecarServer } from "./http-server.ts";

test("rejects an oversized declared body before reading or admitting it", async () => {
  let admitted = false;
  const server = createSidecarServer(async () => {
    admitted = true;
    return Response.json({ ok: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  try {
    const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const client = request(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST", headers: { "content-length": String(64 * 1024 * 1024 + 1) }
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
      client.on("error", reject);
      client.end();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body).error.code).toBe("request_too_large");
    expect(admitted).toBe(false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("cancels a response created after its client already disconnected", async () => {
  let admit!: () => void;
  let release!: () => void;
  let cancelled!: () => void;
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  const server = createSidecarServer(async (incoming) => {
    incoming.signal.addEventListener("abort", release, { once: true });
    admit();
    await ready;
    return new Response(new ReadableStream({ cancel: cancelled }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const client = request(`http://127.0.0.1:${address.port}/v1/responses`, { method: "POST" });
  client.on("error", () => {});
  try {
    client.end("{}");
    await admitted;
    client.destroy();
    await cancellation;
  } finally {
    release();
    client.destroy();
    server.closeAllConnections();
    server.close();
  }
});
