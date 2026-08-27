// 接力回程测试用的**故障注入代理**:夹在源机和目标机之间,按剧本切断某一次
// import(应答丢失)、按需扣住请求稍后再投递、或把某个代理端点装成旧版 404。
// 这些都是纯 fixture,和用例逻辑无关,单独放一份免得测试文件被样板撑破 700 行。
import { createServer } from "node:http";

export async function startReturnProxy(upstream: string): Promise<{ url: string; close(): Promise<void> }> {
  let cutFirstImport = true;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if ((key === "content-type" || key.startsWith("x-ash-peer-")) && typeof value === "string") {
            headers[key] = value;
          }
        }
        const method = req.method ?? "GET";
        const upstreamResponse = await fetch(`${upstream}${req.url}`, {
          method,
          headers,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) }),
        });
        const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
        if (cutFirstImport && req.url?.startsWith("/api/handoff/return/import")) {
          cutFirstImport = false;
          req.socket.destroy();
          return;
        }
        res.statusCode = upstreamResponse.status;
        res.setHeader("content-type", upstreamResponse.headers.get("content-type") ?? "application/json");
        res.end(responseBody);
      })().catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startOrdinaryImportProxy(
  upstream: string,
  forwardBeforeCut: boolean,
  legacyCancel = false,
  cutPath = "/api/handoff/import",
): Promise<{
  url: string;
  deliverHeld(): Promise<{ status: number; body: { error?: string; ash?: boolean } }>;
  setUpstream(url: string): void;
  close(): Promise<void>;
}> {
  let activeUpstream = upstream;
  let cutFirstImport = true;
  let held: { path: string; method: string; headers: Record<string, string>; body: Buffer } | null = null;
  const forward = async (request: NonNullable<typeof held>) => {
    const response = await fetch(`${activeUpstream}${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : {
        body: new Uint8Array(request.body.buffer as ArrayBuffer, request.body.byteOffset, request.body.byteLength),
      }),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
  let closed = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if ((key === "content-type" || key.startsWith("x-ash-peer-")) && typeof value === "string") {
            headers[key] = value;
          }
        }
        const request = {
          path: req.url ?? "/",
          method: req.method ?? "POST",
          headers,
          body: Buffer.concat(chunks),
        };
        if (legacyCancel && request.path.startsWith("/api/handoff/proxy/task/cancel-pending")) {
          res.statusCode = 404;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        if (cutFirstImport && request.path.startsWith(cutPath)) {
          cutFirstImport = false;
          if (forwardBeforeCut) await forward(request);
          else held = request;
          req.socket.destroy();
          return;
        }
        const upstreamResponse = await forward(request);
        res.statusCode = upstreamResponse.status;
        res.setHeader("content-type", upstreamResponse.contentType);
        res.end(upstreamResponse.bytes);
      })().catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    deliverHeld: async () => {
      if (!held) throw new Error("没有待投递的 import 请求");
      const response = await forward(held);
      return { status: response.status, body: JSON.parse(response.bytes.toString("utf8")) as { error?: string; ash?: boolean } };
    },
    setUpstream: (url: string) => { activeUpstream = url; },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * **冒充服务**:占着来源机旧地址的第三方,自报别人的指纹、并把截获的 ping 应答整段
 * 重放。地址发现如果只看自报字段就会被它骗到,所以回归测试拿它当反例。
 */
export async function startImpostorPeer(fingerprint: string, stolenPing: unknown): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url ?? "/";
    if (path.startsWith("/api/handoff/identity")) {
      res.end(JSON.stringify({ fingerprint, short: "假的", host: "impostor" }));
      return;
    }
    if (path.startsWith("/api/handoff/ping")) {
      res.end(JSON.stringify(stolenPing));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
