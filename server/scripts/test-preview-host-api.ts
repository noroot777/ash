// 「只起前端」那一档的 /api 到底打到哪台 ash 上 —— 拿**真的 `npm run dev`** 跑一遍。
//
// 钉的是第 5 轮审查那条：ash 支持任意 PORT（还支持 PORT=0 之后记录真实端口），而
// scripts/dev.mjs 从前把 API 写死成 4317。ash 一换端口，三件事同时错位：
//   ① vite 真把 /api 发往 4317 —— 那个端口上要是坐着另一台 ash，用户以为在验分支，
//      实际在读写那一台（对方是单人模式的话连登录都不用）；
//   ② 它自述的端口跟我们绑着的对不上，登录态直连（PreviewRecord.hostApi）永远开不起来，
//      用户又看回这个任务本来要消掉的登录框；
//   ③ 页面上那句「API 连本机 …」也在说假话。
// 所以这条测试三样一起断言，而且**不许拿假夹具替**：dev.mjs 读环境变量、web/vite.config.ts
// 读 ASH_PROXY、ash 注入 ASH_HOST_API —— 中间断一环，前两条都还能各自「通过」。
//
// 两档一起跑，因为「ASH_PROXY 该不该说了算」的答案取决于它是**谁**写的，而这条链上只有
// ash 组子进程环境那一步分得清：
//   ① 宿主进程带着遗留的 `ASH_PROXY`/`HARNESS_PROXY`（见下面开头两行）→ 默认 `npm run dev`
//      仍须打到 boundListeningPort()（第 7 轮审查 P1）
//   ② 命令现场写 `ASH_PROXY=$URL2` → 仍须打到分支自己的后端（第 6 轮审查 P1）
//
// 跑法：npm -w server run test:preview-host-api
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(realpathSync(tmpdir()), "ash-preview-host-api-"));
process.env.ASH_DB = join(root, "test.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_DEPS_DIR = join(root, "deps");
const { ensureSchema, dbClient } = await import("../src/db/index.js");
const { startPreview, stopPreview, readPreview } = await import("../src/preview.js");
const { recordListeningPort } = await import("../src/listening-port.js");
const { REPO_DIR } = await import("../src/paths.js");
const { tail } = await import("../src/preview-store.js");
await ensureSchema();

// 宿主 ash 进程自己环境里带着的「打哪台」——`ASH_PROXY=… npm run start` 起的、systemd 里
// 写了一行、或者这台 ash 自己就跑在上一层预览里。它跟这次预览要连谁毫无关系，**一个都不许
// 漏进预览子进程**：漏进去就压掉了下面注入的真实监听端口，默认「只起前端」的 /api 整个打去
// 别处（第 7 轮审查 P1）。旧名 `HARNESS_PROXY` 一并预置：scripts/env.mjs 会把 `HARNESS_*`
// 提升成 `ASH_*`，只擦新名等于留了条绕道。
process.env.ASH_PROXY = "http://127.0.0.1:1";
process.env.HARNESS_PROXY = "http://127.0.0.1:2";

// 冒充「这台 ash」：随便一个空闲端口，**不是 4317**。谁打过来它都记下来。
const seen: string[] = [];
const host = createServer((req, res) => {
  seen.push(req.url ?? "");
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ iAm: "host ash", url: req.url }));
});
host.listen(0, "127.0.0.1");
if (!host.listening) await once(host, "listening");
const address = host.address();
assert(address && typeof address === "object");
assert.notEqual(address.port, 4317, "这条测试的前提就是「ash 不在 4317 上」");
// index.ts 在 listen 回调里做的同一件事。
recordListeningPort(address.port);

let failed: unknown = null;
try {
  const started = await startPreview("host-api-task", {
    id: "front", kind: "preview",
    p: { cmd: "npm run dev", mode: "frontend", ready: "port", life: "task" },
    fail: null,
  } as never, REPO_DIR);
  assert(started.ok, started.ok ? "" : started.reason);
  const record = readPreview("host-api-task")!;
  const log = tail(record.log, "", Number.MAX_SAFE_INTEGER);

  // ① 自述和那句人话都得说出我们真绑着的端口，不是 4317，也不是继承来的那份。
  assert.match(log, new RegExp(`\\[ash\\] preview-api-host 127\\.0\\.0\\.1:${address.port}\\b`), `自述必须指向 ${address.port}\n${log.slice(0, 600)}`);
  assert(!log.includes("preview-api-host 127.0.0.1:4317"), "不许再写死 4317");
  assert(!/127\.0\.0\.1:[12]\b/.test(log), `父进程带下来的 ASH_PROXY/HARNESS_PROXY 一个字都不该起作用\n${log.slice(0, 600)}`);
  assert.match(log, new RegExp(`只起前端 \\d+，/api 打到 127\\.0\\.0\\.1:${address.port}`), "给人看的那行同样不许说假话");

  // ② 判读侧认下了，登录态直连这一档才开得起来（缘由见 preview-access.ts 顶部）。
  assert.equal(record.hostApi, address.port, "ready 记录里的 hostApi 就是当前绑着的端口");

  // ③ 最要紧的一条：vite **真的**把 /api 发到了这台上。前两条全对而这条错，
  //    等于我们对着一台错的 ash 说「已经带你登录了」。
  const probe = `/api/_preview_host_probe_${address.port}`;
  const answer = await fetch(`http://127.0.0.1:${record.port}${probe}`);
  const body = await answer.text();
  assert.equal(answer.status, 200, body);
  assert.deepEqual(JSON.parse(body), { iAm: "host ash", url: probe }, "/api 的实际去向就是这台");
  assert(seen.includes(probe), "这台确实收到了那一发");

  // —— 第二档：一条多行的整栈脚本，自己把前端指向自己起的分支后端 ——
  //
  // 项目设置明说支持「完整脚本」，`PORT2`/`URL2` 就是为这种写法借的。这句 `ASH_PROXY=$URL2`
  // 是用户**明说**「前端连我这个分支后端」，宿主地址压掉它就等于把 /api 悄悄接回主 ash：
  // 用户以为在验分支后端，实际是拿自己的身份读写主库（第 6 轮审查 P1）。
  // 后端用一行 node 顶替（真实形状是 `PORT=$PORT2 npm -w server run dev &`）——要钉的是
  // 「ASH_PROXY 压不压得住」，不是那套后端本身。
  const hostSoFar = seen.length;
  const stack = 'node -e "require(\'node:http\').createServer((q,r)=>{r.setHeader(\'content-type\',\'application/json\');'
    + 'r.end(JSON.stringify({iAm:\'branch backend\',url:q.url}))}).listen(process.env.PORT2)" &\n'
    + "ASH_PROXY=$URL2 npm run dev";
  const both = await startPreview("stack-task", {
    id: "stack", kind: "preview",
    p: { cmd: stack, mode: "frontend", ready: "port", life: "task" },
    fail: null,
  } as never, REPO_DIR);
  assert(both.ok, both.ok ? "" : both.reason);
  const stackRecord = readPreview("stack-task")!;
  const stackLog = tail(stackRecord.log, "", Number.MAX_SAFE_INTEGER);
  const port2 = /\bURL2=http:\/\/localhost:(\d+)/.exec(stackLog)?.[1];
  assert(port2, `没拿到 URL2，命令回显是：\n${stackLog.slice(0, 400)}`);

  const stackProbe = "/api/_explicit_proxy_probe";
  const stackAnswer = await fetch(`http://127.0.0.1:${stackRecord.port}${stackProbe}`);
  const stackBody = await stackAnswer.text();
  assert.equal(stackAnswer.status, 200, stackBody);
  assert.deepEqual(JSON.parse(stackBody), { iAm: "branch backend", url: stackProbe }, "脚本自己写的 ASH_PROXY 说了算");
  assert.equal(seen.length, hostSoFar, "主 ash 一发都不该收到");

  // 自述跟着实际去向走，于是跟我们绑着的端口对不上 —— 这一档自然就没有登录态直连。
  assert.match(stackLog, new RegExp(`\\[ash\\] preview-api-host localhost:${port2}\\b`), "自述报的是它真打过去的那个");
  assert(!stackLog.includes(`preview-api-host 127.0.0.1:${address.port}`), "不许报成主 ash");
  assert(!/127\.0\.0\.1:[12]\b/.test(stackLog), "继承来的那份在这一档同样不该露头");
  assert.equal(stackRecord.hostApi ?? null, null, "整栈脚本这一档不许产生 hostApi");

  // —— 第三档：这台 ash 说不出自己在哪的时候 ——
  //
  // `ASH_HOST_API` 自己也会被继承：ash 跑在上一层预览里时，环境里那份指的是**外层**那台。
  // 平时我们注入的值盖在它上面，可 `boundListeningPort()` 是 null（还没 listen 上、端口没记
  // 成）时我们一个字都不注入 —— 漏下来就等于让这次预览默认去连外层那台 ash。
  // 这一档不需要真前端，一行 node 把子进程**实际收到**的值打回来就够。打的时候剥掉 scheme：
  // 日志里出现 `http://…` 会被就绪判定当成预览本尊的地址，那样漏没漏得等 120 秒超时才看得出来。
  recordListeningPort(0);
  process.env.ASH_HOST_API = "http://127.0.0.1:3";
  const echo = "node -e \"console.log('[env] ASH_HOST_API=' + (process.env.ASH_HOST_API ?? '<空>').replace('http://',''));"
    + "require('node:http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT)\"";
  const blind = await startPreview("blind-task", {
    id: "blind", kind: "preview",
    p: { cmd: echo, mode: "frontend", ready: "port", life: "task" },
    fail: null,
  } as never, REPO_DIR);
  assert(blind.ok, blind.ok ? "" : blind.reason);
  const blindLog = tail(readPreview("blind-task")!.log, "", Number.MAX_SAFE_INTEGER);
  assert.match(blindLog, /\[env\] ASH_HOST_API=<空>/, `说不出自己在哪就什么都别说，别把继承来的那份递下去\n${blindLog.slice(0, 400)}`);
} catch (error) {
  failed = error;
}
await stopPreview("host-api-task", null).catch(() => {});
await stopPreview("stack-task", null).catch(() => {});
await stopPreview("blind-task", null).catch(() => {});
host.close();
dbClient.close();
rmSync(root, { recursive: true, force: true });
if (failed) throw failed;
console.log("preview host API tests passed: 只起前端那一档的 /api 跟着 ash 实际监听的端口走");
process.exit(0);
