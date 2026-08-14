// 拿**真 claude** 对一遍 `claude-settings.ts` 里那套分层假设。
//
// 为什么单独一条:那份顺序不是照抄文档、是黑盒实测出来的(见该文件顶部注释),CLI 换个
// 版本就可能漂。漂了之后 harness 仍然算得出一个数、页面仍然写着「已覆盖」,只是那个数
// 跟 CLI 真正用的对不上 —— 这种错没有任何纯函数测试能发现,只有让 claude 自己说出它
// 看到的值才行(前三轮审查都是这么抓到的)。
//
// 花的钱:每个场景起一次 `claude -p`,靠 `--settings` 里的 SessionStart 钩子把它**自己
// 进程里**的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 打进文件,拿到就杀 —— 钩子在会话初始化
// 阶段跑,模型一次都不会被调用。
//
// 跑法(本机没装 claude 会自己跳过,所以可以进 CI):
//   HARNESS_DB=/tmp/test-claude-settings-live-$RANDOM.db npx tsx server/scripts/test-claude-settings-live.ts
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const { claudeMaxOutputTokens } = await import("../src/executors/claude-settings.js");

const NAME = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
const skip = (why: string) => {
  console.log(`claude settings live: 跳过(${why})`);
  process.exit(0);
};

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) skip("本机没装 claude");

// 企业策略那一层压在所有人头上。这台机器上真写过这一项的话,下面每个场景的答案都会
// 变成同一个数,测了也说明不了分层 —— 与其给个假绿,不如明说跳过。
const managed =
  platform() === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : "/etc/claude-code/managed-settings.json";
if (existsSync(managed) && readFileSync(managed, "utf8").includes(NAME)) skip(`${managed} 里写过 ${NAME}`);

const scratch = mkdtempSync(join(tmpdir(), "harness-claude-live-"));
const hookFile = join(scratch, "hook.txt");
const repo = join(scratch, "repo");
const wt = join(scratch, "wt"); // 跟 repo 平级:目录树上互不包含,才测得出「按 git 关系找主仓」
const home = join(scratch, "home");
const altConfig = join(scratch, "alt-config");

const git = (...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} 失败:${r.stderr}`);
};

/** 写一层 settings(value 为 null = 删掉这一层)。 */
function layer(dir: string, file: "settings.json" | "settings.local.json", value: number | null) {
  const path = join(dir, ".claude", file);
  if (value === null) return rmSync(path, { force: true });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ env: { [NAME]: String(value) } }));
}

/**
 * 真 claude 在 `cwd` 下最终看到的 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`(哪一层都没写 = null)。
 * 这里的 `--settings` 只放钩子、不放 env,免得自己搅进被测的分层里。
 */
async function askClaude(cwd: string, extraEnv: Record<string, string | undefined> = {}): Promise<number | null> {
  rmSync(hookFile, { force: true });
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: `printf '%s' "$${NAME}" > ${JSON.stringify(hookFile)}` }] }],
    },
  };
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
  delete env[NAME]; // 继承来的那份会让每个场景都有个保底答案,测不出「读不到」
  const child = spawn(
    "claude",
    ["-p", "ping", "--output-format", "stream-json", "--verbose", "--settings", JSON.stringify(settings)],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.resume();
  child.stderr.resume();
  try {
    for (let i = 0; i < 300 && !existsSync(hookFile); i++) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    child.kill("SIGKILL"); // 钩子已经跑完 = 初始化到位了,不必等它去调模型
  }
  assert.ok(existsSync(hookFile), `SessionStart 钩子没跑起来(cwd=${cwd});claude 换了钩子协议?`);
  const raw = readFileSync(hookFile, "utf8").trim();
  return raw ? Number(raw) : null;
}

/** 同一个场景问两边:真 claude 一份、harness 的静态推算一份,必须一致。 */
async function agree(what: string, cwd: string, extraEnv: Record<string, string | undefined> = {}) {
  const before = process.env.CLAUDE_CONFIG_DIR;
  const realHome = process.env.HOME;
  process.env.HOME = home; // claudeMaxOutputTokens 读 ~/.claude,得跟子进程看同一个家
  if ("CLAUDE_CONFIG_DIR" in extraEnv) {
    if (extraEnv.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = extraEnv.CLAUDE_CONFIG_DIR;
  }
  try {
    const truth = await askClaude(cwd, extraEnv);
    assert.equal(claudeMaxOutputTokens(cwd), truth, `${what}:真 claude 用的是 ${truth},harness 却按别的值换算`);
    console.log(`  ✓ ${what} → ${truth ?? "读不到"}`);
    return truth;
  } finally {
    process.env.HOME = realHome!;
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
}

try {
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(altConfig, { recursive: true });
  git("init", "-q", repo);
  git("-C", repo, "commit", "--allow-empty", "-qm", "init");
  git("-C", repo, "worktree", "add", "-q", wt, "-b", "probe");
  assert.ok(existsSync(join(wt, ".git")), "linked worktree 没建起来");

  // ── ① linked worktree 不是独立项目:local 档认主仓、shared 档认当前目录 ──────────
  layer(repo, "settings.local.json", 8000);
  layer(wt, "settings.local.json", 5000);
  assert.equal(await agree("worktree 里跑,两边都有 settings.local.json", wt), 8000, "主仓那份该赢");

  layer(wt, "settings.local.json", null);
  assert.equal(await agree("只有主仓有 settings.local.json", wt), 8000, "worktree 里看不见就等于没配了");

  layer(repo, "settings.local.json", null);
  layer(wt, "settings.local.json", 5000);
  assert.equal(await agree("只有 worktree 有 settings.local.json", wt), 5000, "主仓没写才轮到它");

  layer(wt, "settings.local.json", null);
  layer(repo, "settings.json", 8888);
  layer(wt, "settings.json", 5000);
  assert.equal(await agree("两边都有 settings.json", wt), 5000, "shared 档反过来:就近赢");

  layer(repo, "settings.local.json", 8000);
  assert.equal(await agree("主仓 local vs worktree shared", wt), 8000, "local 档整体高于 shared 档");

  // ── ② CLAUDE_CONFIG_DIR 整个取代 ~/.claude,不回落 ─────────────────────────────
  layer(repo, "settings.local.json", null);
  layer(repo, "settings.json", null);
  layer(wt, "settings.json", null);
  layer(home, "settings.json", 12000);
  assert.equal(await agree("只有用户层", repo, { CLAUDE_CONFIG_DIR: undefined }), 12000);

  // 注意:`CLAUDE_CONFIG_DIR` 顶掉的是 `~/.claude` 这一整个目录,settings.json 直接躺在
  // 它下面(不是再套一层 .claude),所以这里不能用上面的 layer()。
  writeFileSync(join(altConfig, "settings.json"), JSON.stringify({ env: { [NAME]: "7000" } }));
  assert.equal(await agree("CLAUDE_CONFIG_DIR 指到别处", repo, { CLAUDE_CONFIG_DIR: altConfig }), 7000);

  rmSync(join(altConfig, "settings.json"), { force: true });
  assert.equal(
    await agree("CLAUDE_CONFIG_DIR 指到空目录", repo, { CLAUDE_CONFIG_DIR: altConfig }),
    null,
    "不会退回 HOME 的那份 —— 退回的话这里会是 12000",
  );

  console.log("claude settings live: ok");
} finally {
  spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(scratch, { recursive: true, force: true });
}
