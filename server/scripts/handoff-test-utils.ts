// test-handoff 的进程/仓库/HTTP 工具。从主文件拆出来只为压体积,不含断言编排逻辑。
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

export function makeRepo(path: string): string {
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, "config", "user.name", "Ash Handoff Test");
  git(path, "config", "user.email", "handoff@example.test");
  writeFileSync(join(path, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "seed");
  return path;
}

/** 起对端 server(PORT=0),等 ready 行,返回 baseUrl。onProc 在 spawn 后立即回调,
 * 让调用方在 ready 之前就持有进程句柄——超时/早退时也能兜底击杀。 */
export async function startPeer(
  env: Record<string, string>,
  onProc: (proc: ChildProcess) => void,
): Promise<string> {
  const serverDir = join(import.meta.dirname, "..");
  const tsxCli = join(serverDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
  const peer = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onProc(peer);
  let buf = "";
  return new Promise<string>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`对端 server 30s 没 ready,输出:\n${buf}`)), 30_000);
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/server on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(`http://127.0.0.1:${m[1]}`);
      }
    };
    peer.stdout!.on("data", onChunk);
    peer.stderr!.on("data", onChunk);
    peer.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`对端 server 提前退出(code ${code}),输出:\n${buf}`));
    });
  });
}

export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}/api${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  assert.ok(res.ok, `${path} 应答 ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/**
 * 配对:让对端批准本测试进程(源机)的接力身份。
 * 新版接力默认要求入站审批,不先配对的话 /refs 和 /import 一律 401——这一步就是
 * 用户在对端设置页点「批准」的等价物。先发一次签名 ping 让对端认识本机(那是配对
 * 请求本身),再按指纹放行。
 */
export async function pairWithPeer(peerBase: string): Promise<string> {
  const { pingPeer } = await import("../src/handoff-peer-client.js");
  const { localIdentity } = await import("../src/handoff-identity.js");
  await pingPeer(peerBase);
  const me = localIdentity().fingerprint;
  const { peers } = await api<{ peers: { fingerprint: string; status: string }[] }>(peerBase, "/handoff/peers");
  assert.ok(peers.some((p) => p.fingerprint === me), "签名 ping 之后源机应出现在对端的待批准列表里");
  await api(peerBase, `/handoff/peers/${me}/approve`, { method: "POST" });
  return me;
}

/** startFakePeer 交给 onImport 的手柄:要么转发给真对端,要么自己编一个应答。 */
export interface FakePeerImportCtx {
  /** 请求体原样。 */
  body: Buffer;
  /** 原样转发给真对端,拿回它的状态码和应答体。 */
  forward(): Promise<{ status: number; body: Buffer }>;
  /** 直接掐断连接:制造「请求可能已送达、应答没回来」。 */
  destroy(): void;
  reply(status: number, body: Buffer | unknown): void;
}

/**
 * 站在真对端前面的假对端(中间人/坏网关)。ping 与 refs 本地应答,**不报身份** ——
 * 源机会把它当旧版对端,这正是这类用例想要的:验的是网络语义,不是身份核对。
 * /import 交给 `onImport` 决定:掐断、原样转发、或者篡改转发结果。
 *
 * 转发一定把 `x-ash-peer-*` 头带上:签名覆盖 method+path+body,少带一个头对端直接 401。
 * 转发代理天生会破坏「地址 = 那台机器」的直觉,而签名恰好只认身份不认地址。
 */
export async function startFakePeer(opts: {
  host: string;
  /** 真对端根地址,forward() 往这里发。 */
  upstream: string;
  project: { id: string; name: string; repoPath: string };
  onImport(ctx: FakePeerImportCtx): void | Promise<void>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const json = (payload: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (req.url?.includes("/api/handoff/ping")) {
      json({ ok: true, service: "ash", host: opts.host, projects: [{ ...opts.project, isRepo: true }] });
      return;
    }
    if (req.url?.includes("/refs")) {
      json({ refs: [] });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      void Promise.resolve(opts.onImport({
        body,
        forward: async () => {
          const headers: Record<string, string> = {
            "content-type": req.headers["content-type"] ?? "application/json",
          };
          for (const [k, v] of Object.entries(req.headers)) {
            if (k.startsWith("x-ash-peer-") && typeof v === "string") headers[k] = v;
          }
          const upstream = await fetch(`${opts.upstream}${req.url}`, {
            method: req.method ?? "POST",
            headers,
            body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
          });
          return { status: upstream.status, body: Buffer.from(await upstream.arrayBuffer()) };
        },
        destroy: () => req.socket.destroy(),
        reply: (status, payload) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
        },
      })).catch(() => req.socket.destroy());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
