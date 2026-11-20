import { get } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "@navi/shared/env-names";
import { releaseCodeLockForExec } from "@navi/shared/code-lock";

export async function redirectPackagedMcp(): Promise<void> {
  if (process.platform !== "darwin") return;
  const source = fileURLToPath(new URL("../..", import.meta.url));
  if (!source.includes(".app/Contents/")) return;
  let id: string;
  try { id = JSON.parse(readFileSync(join(source, "runtime-manifest.json"), "utf8")).id; }
  catch { return; }
  const url = new URL(readEnv(process.env, "NAVI_URL") ?? "http://127.0.0.1:4317");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return;
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/health`;
  const deadline = Date.now() + 60_000;
  do {
    const health = await new Promise<Record<string, any> | null>((done) => {
      const request = get(url, { timeout: 1000 }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; if (body.length > 64_000) request.destroy(); });
        response.on("end", () => { try { done(response.statusCode === 200 ? JSON.parse(body) : null); } catch { done(null); } });
        response.on("error", () => done(null));
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => done(null));
    });
    if (health?.ok === true && health.instance?.desktop === true) {
      try {
        const target = realpathSync(health.instance.codeDir);
        const store = realpathSync(join(health.instance.dataDir, ".runtimes"));
        const manifest = JSON.parse(readFileSync(join(target, "runtime-manifest.json"), "utf8"));
        if (dirname(target) === store && target === join(store, id) && manifest.id === id) {
          const node = join(target, "node/bin/node");
          releaseCodeLockForExec();
          process.execve!(node, [node, join(target, "mcp/dist/index.js")], process.env as Record<string, string>);
          throw new Error("运行时 exec 未替换进程");
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
      break;
    }
    await new Promise((done) => setTimeout(done, 200));
  } while (Date.now() < deadline);
  throw new Error("app 内的 MCP 尚不能切换到已发布运行时；请等服务就绪后重连，未在可替换的 app 内常驻");
}
