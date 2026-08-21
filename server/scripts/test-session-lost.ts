/**
 * 「CLI 否认了这条会话」的识别与清理。
 *
 * 起因(2026-08-21,172.16.88.252):任务第一次起跑就被 claude 的 root 闸拒掉,stdout
 * 0 字节 —— 会话压根没建起来,但 ash 在 spawn 那一刻就把自己发的 session id 落了库。
 * 之后每一次重试都 `--resume` 一个从不存在的会话,稳定失败,报的还是另一句话。用户
 * 把真正的病因(root 闸)修好了,任务照样红,两件事看不出关系。
 *
 * 这条链子有三节,断哪节都会静默失效,所以三节都在这儿钉住:
 *   ① claude 执行器把 CLI 那句原话**原样**带出来(它对别的错误是会改写的)
 *   ② isSessionLost 认得这句、且不误伤别的错误(误清 = 白丢一条能续的会话)
 *   ③ 清理要抹掉由那个 id 派生的全部字段,不是只抹 id
 * 跑:npm -w server run test:session-lost
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOST_SESSION_PATCH, isSessionLost } from "../src/executors/session-lost.js";
import { parseClaudeStream } from "../src/executors/claude.js";

const dir = mkdtempSync(join(tmpdir(), "ash-session-lost-"));
const ok = (m: string) => console.log("   ✓ " + m);

// 真机原话(claude 2.1.220,`claude --resume <uuid>` 指向一个不存在的 transcript)。
const REAL = "No conversation found with session ID: 6f8c7cdd-b820-416e-a4f3-96b516d6a8e2";

// ── ② 认得这句 ──────────────────────────────────────────────────────────────

assert.equal(isSessionLost(REAL), true, "真机原话");
assert.equal(isSessionLost(`Error: ${REAL}\n`), true, "被包在别的话里也算");
assert.equal(isSessionLost(REAL.toLowerCase()), true, "大小写不敏感");
ok("认得 claude 的「这条会话我不认识」");

// 反面:这些都不该清会话。第一条尤其重要 —— 它正是 2026-08-21 那次的**真病因**,
// 会话那时是好的(压根还没建),清它没意义,只会把「为什么失败」搅浑。
for (const other of [
  "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons",
  "Credit balance is too low",
  "API Error: 404 model not found",
  "Invalid session ID format",
  "",
]) {
  assert.equal(isSessionLost(other), false, `不该误判:${other.slice(0, 40)}`);
}
ok("不误伤 root 闸 / 余额 / 404 / 格式错 等其它失败");

// ── ① 执行器原样带出来 ──────────────────────────────────────────────────────
// claude.ts 对 CLI 的 stderr 有一层措辞归一(normalizeClaudeCliError)。这句要是哪天
// 被改写成中文提示,上面那把正则就静默失配了 —— 那才是最难查的坏法:功能没了,测试
// 全绿。所以这里走真的解析器,而不是直接拿字符串喂 isSessionLost。
const script = join(dir, "stub.mjs");
writeFileSync(script, `process.stderr.write(${JSON.stringify(REAL + "\n")}); process.exitCode = 1;`);
const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
child.stdin?.end();
const events: any[] = [];
for await (const event of parseClaudeStream(child as any)) events.push(event);
const errors = events.filter((e) => e.kind === "error").map((e) => e.message as string);
assert.ok(errors.length > 0, "非零退出要报一条 error 事件");
assert.ok(errors.some((m) => isSessionLost(m)), `error 事件里认不出会话失效:${JSON.stringify(errors)}`);
ok("claude 执行器把这句原样带出来,识别接得上");

// ── ③ 清理抹干净 ────────────────────────────────────────────────────────────
// 只抹 cli_session_id 不够:三件套恢复命令是由它派生的,留着就是给用户一条复制粘贴
// 就撞墙的命令。(少了哪一列会编译不过,这里再从值上确认一次。)
assert.deepEqual(
  LOST_SESSION_PATCH,
  { cliSessionId: null, resumeCommand: null, resumeEnv: null, resumeArgs: null },
  "失效会话要连派生的恢复命令一起清掉",
);
ok("清理覆盖 id + 三件套恢复命令");

rmSync(dir, { recursive: true, force: true });
console.log("session-lost: 全部通过");
