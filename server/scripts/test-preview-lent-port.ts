// 「起来了，但没起在我借给它的那个端口上」——拿**真的进程**跑一遍两种命令。
//
// 这一句以前是完全沉默的：预览照样接得上（pickPreviewUrl 认日志里印的地址），所以系统放行，
// 用户永远学不到 $PORT 这回事，直到某天同一个项目的第二份预览起不来。措辞由
// test:preview-log 钉（那是纯函数），**这条钉的是它到底在不在该在的时候出现**——而这件事
// 只有真跑才问得出来，因为搞错 `lent` 的语义会让它在每一次正常预览里都冒出来，那就是
// 给每份日志加噪音，比不提示更糟。
//
// 所以两档都要：
//   ① 命令**认了** $PORT → 一个字都不许多说；
//   ② 命令**没认**，自己挑了个端口 → 必须说，而且两个端口号都得在。
//
// 跑法：npm -w server run test:preview-lent-port
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

const root = mkdtempSync(join(realpathSync(tmpdir()), "ash-preview-lent-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { ensureSchema, dbClient } = await import("../src/db/index.js");
const { startPreview, stopPreview } = await import("../src/preview.js");
const { tail } = await import("../src/preview-store.js");
await ensureSchema();

/** 一个空闲端口，用来当「命令自己写死的那个」。 */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

/** 一行 node：在 `where` 说的端口上起个 HTTP 服务，并照 dev server 的惯例把地址印出来。 */
const server = (where: string) =>
  `node -e "const p=${where};require('http').createServer((q,s)=>s.end('ok')).listen(p,'127.0.0.1',()=>console.log('  ➜  Local:   http://localhost:'+p+'/'))"`;

const cwd = mkdtempSync(join(realpathSync(tmpdir()), "ash-preview-lent-wt-"));
const run = async (taskId: string, cmd: string) => {
  const result = await startPreview(taskId, {
    id: "preview", kind: "preview",
    p: { cmd, mode: "frontend", ready: "port", life: "task" },
  } as never, cwd);
  assert.ok(result.ok, `预览没起来，谈不上判断端口：${result.ok ? "" : result.reason}`);
  return { record: result.record, log: tail(result.record.log, "", 8000) };
};

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { console.log(`✓ ${name}`); return; }
  ++failures;
  console.log(`✗ ${name}\n    实际 ${JSON.stringify(actual)}\n    期望 ${JSON.stringify(expected)}`);
};

try {
  // ① 认了 ash 借的端口 —— 正常情况，一个字都不许多说。搞错 lent 的语义就会在这里露馅：
  //    每一次正常预览的日志里都多出三行噪音。
  const good = await run("obedient", server("process.env.PORT"));
  check("认了 $PORT 就不啰嗦", good.log.includes("[ash] 注意"), false);
  check("预览记录里的端口就是借出去的那个", good.record.port === Number(/PORT=(\d+)/.exec(good.log)?.[1]), true);
  await stopPreview("obedient", null);

  // ② 端口写死，没吃 ash 借的那个 —— 这正是 $PORT 没写进命令的症状。
  const pinned = await freePort();
  const own = await run("stubborn", server(String(pinned)));
  const lent = Number(/PORT=(\d+)/.exec(own.log)?.[1]);
  check("这一档本来就该起在别的端口上（前提核对）", own.record.port === pinned && lent !== pinned, true);
  check("说了这件事", own.log.includes("[ash] 注意"), true);
  check("它自己起的那个端口写出来了", own.log.includes(`起在 ${pinned}`), true);
  check("ash 借的那个也写出来了，用户才对得上", own.log.includes(`借给它的 ${lent}`), true);
  // 不判失败：命令是用户的，他有权让服务听一个固定端口。预览照常可用。
  check("没因此把预览判死", own.record.state, "ready");
  await stopPreview("stubborn", null);
} finally {
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);
