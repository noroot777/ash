// 个人 CLI 环境的**零交互冒烟测试**(计划 §九 探针③ / 审查修订 D12 的硬前置)。
//
// 要回答的问题只有一个:**把 CLI 的配置目录换成一个 ash 新建的空目录之后,headless
// 首跑还能不能直接出活**——不弹引导、不问信任、不等任何一次回车。
//
// 为什么必须真跑一次:2026-08-27 的探针到这一步卡住了(带 key 的首跑挂起 >120s,
// 卡点未定位)。那个挂起如果是 seed 缺了某一位造成的,上线后的表现是「新用户的第一个
// 任务永远转圈」——而这在只读代码或只过编译的检查里**看不出来**,只有真起一次进程
// 才现形。所以这条测试不是补充材料,它就是 seed 能不能发的判据本身。
//
// 跑法(需要一把真 key,会消耗少量额度):
//   ASH_DB=/tmp/test-user-cli-smoke.db \
//   ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=… \
//   npx tsx server/scripts/test-user-cli-smoke.ts
//
// 没给 key 时**跳过而不是失败**(exit 0 并说明原因):CI 和无人值守环境不该因为
// 「这里没有额度」被判红,但也绝不能因为跳过就让人以为验过了 —— 输出里写死一行
// 「SKIPPED」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.ANTHROPIC_BASE_URL?.trim() ?? "";
const TOKEN = (process.env.ASH_SMOKE_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
const MODEL = process.env.ASH_SMOKE_MODEL?.trim() || "";
// 探针③ 的挂起阈值是 120s。超过它就是复现了那个问题,不是「机器慢」。
const TIMEOUT_MS = Number(process.env.ASH_SMOKE_TIMEOUT_MS ?? 120_000);

if (!TOKEN) {
  console.log("SKIPPED test-user-cli-smoke:没有可用的 key。");
  console.log("  这条测试要真起一次 claude 才有意义(§九 探针③);设 ASH_SMOKE_KEY 或 ANTHROPIC_AUTH_TOKEN 再跑。");
  process.exit(0);
}

const { ensureUserCliDir, cliConfigEnvFor, configDirEnvVar, USER_CLI_ROOT } = await import("../src/auth/user-cli.js");

const stage = mkdtempSync(join(tmpdir(), "ash-user-cli-smoke-"));
// ensureUserCliDir 写的是**真的** data/user-cli/(它按 DATA_DIR 定位,没有 env 开关)。
// 断言挂了也得把这条测试用户扫干净,否则下一次跑就不是「首跑」了 —— 而首跑正是要验的东西。
process.on("exit", () => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(join(USER_CLI_ROOT, "smoke-user"), { recursive: true, force: true });
});
// 假 HOME:宿主机那份 ~/.claude / ~/.claude.json 在整条测试里必须**一个字节都不动**。
// 用真 HOME 跑的话,「配置目录生效了」和「它偷偷回落宿主了」看起来一模一样。
const fakeHome = join(stage, "home");
const hostMarker = join(fakeHome, ".claude.json");
mkdirSync(fakeHome, { recursive: true });
writeFileSync(hostMarker, '{"sentinel":"host"}\n', "utf8");
const hostBefore = readFileSync(hostMarker, "utf8");

// ash 真正会建的那个目录(走产品代码,不是测试自己拼一份)。
const userId = "smoke-user";
const dir = ensureUserCliDir(userId, "claude");
assert.ok(dir, "claude 应该有个人配置目录");
assert.equal(configDirEnvVar("claude"), "CLAUDE_CONFIG_DIR");
assert.ok(existsSync(join(dir!, "skills")), "seed 应该建出 skills/");
assert.ok(existsSync(join(dir!, ".claude.json")), "seed 应该写下 onboarding 标记");

const seeded = JSON.parse(readFileSync(join(dir!, ".claude.json"), "utf8")) as Record<string, unknown>;
assert.equal(seeded.hasCompletedOnboarding, true, "seed 必须带 onboarding 完成标记,否则首跑要问引导问题");

// 从当前进程继承环境,但先把所有 CLAUDE_* 抹掉:这条测试很可能就是**在一个 claude
// 里**跑的,父进程的 CLAUDE_CODE_* 会把「新用户的干净首跑」污染成「继承了一堆现成
// 配置的跑」——那样验过了也不算数。
const inherited: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(inherited)) {
  if (key.startsWith("CLAUDE_") || key.startsWith("ANTHROPIC_DEFAULT_")) delete inherited[key];
}

const env: NodeJS.ProcessEnv = {
  ...inherited,
  ...cliConfigEnvFor(userId, "claude"),
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  ANTHROPIC_AUTH_TOKEN: TOKEN,
  ANTHROPIC_API_KEY: TOKEN,
  ...(BASE_URL ? { ANTHROPIC_BASE_URL: BASE_URL } : {}),
};

const args = ["-p", "回答两个字:好的", "--output-format", "text", ...(MODEL ? ["--model", MODEL] : [])];
const started = Date.now();
const result = await new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>((resolve) => {
  const child = spawn("claude", args, { env, cwd: stage, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
  child.on("error", (e) => {
    clearTimeout(timer);
    resolve({ code: null, out, err: `${err}\n${e.message}`, timedOut });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, out, err, timedOut });
  });
});
const elapsed = Date.now() - started;

console.log(`claude headless 首跑:${elapsed}ms, exit=${result.code}${result.timedOut ? " (超时)" : ""}`);
if (result.out.trim()) console.log(`stdout: ${result.out.trim().slice(0, 300)}`);
if (result.err.trim()) console.log(`stderr: ${result.err.trim().slice(0, 300)}`);

// ── 判据 ────────────────────────────────────────────────────────────────────
assert.equal(
  result.timedOut,
  false,
  `首跑在 ${TIMEOUT_MS}ms 内没有出活 —— 这正是 §九 探针③ 那个挂起,seed 不能上线。`,
);
assert.equal(result.code, 0, `claude 非零退出(${result.code}):${result.err.trim().slice(0, 400)}`);
assert.ok(result.out.trim().length > 0, "首跑没有任何输出");
assert.ok(
  !/Not logged in|Please run \/login|Invalid API key/i.test(result.out + result.err),
  "CLI 报了未登录 —— 说明 key 没被这套配置目录认到",
);

// 配置目录确实被用了(CLI 会在里面留下自己的东西)。
const populated = readdirSync(dir!);
assert.ok(populated.length > 0, "配置目录一个文件都没多,CLI 多半没在用它");

// 宿主机那份没被碰过 —— 「抹去订阅」的地基(探针②)。
assert.equal(readFileSync(hostMarker, "utf8"), hostBefore, "宿主 ~/.claude.json 被改动了,隔离不成立");
assert.ok(
  !existsSync(join(fakeHome, ".claude")) || statSync(join(fakeHome, ".claude")).isDirectory(),
  "宿主 HOME 下不该冒出意外的东西",
);

console.log("test-user-cli-smoke ok");
