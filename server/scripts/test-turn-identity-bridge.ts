// 回合身份搭 `PATH` 那班车的那条通路(copilot 这类只自动继承 `PATH` 的 CLI 靠它交卷)。
//
// 为什么需要这条桥、为什么是**按回合**开目录:约定本体在 `@ash/shared/mcp` 的
// `ASH_TURN_IDENTITY_PATH_DIR`,写的一侧是 `server/src/turn-identity.ts`,读的一侧是
// `mcp/src/runtime.ts`。这里盯的是那份约定里最吃紧的四件事:
//
//   ① **只多一段、追加在末尾**:盖不掉用户的任何命令,目录里也没有可执行文件;
//   ② **换回合就作废**:上一回合的残留 MCP 子进程读到空,而不是**当前**令牌 ——
//      读到当前令牌就是一次跨回合的身份冒用,比交不了卷糟得多;
//   ③ **继承来的别人家身份一律筛掉**:ash 自己可能就是从一条 ash 任务里起来的,
//      那份 `PATH` 里带着**那条任务**的身份目录。设和清两侧都要筛;
//   ④ **读的那一侧真读得到**,而且**变量优先** —— 变量在就不看文件。
//
// 跑:`npm -w server run test:turn-identity`
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ASH_TURN_IDENTITY_ENV, ASH_TURN_IDENTITY_FILE, ASH_TURN_IDENTITY_PATH_DIR, isTurnIdentityPathEntry,
} from "@ash/shared/mcp";

const root = mkdtempSync(join(tmpdir(), "ash-turn-identity-"));
const runs = join(root, "runs");
mkdirSync(runs, { recursive: true });
// paths.ts 在**模块加载时**读这个变量,所以必须先设再 import(下面一律动态 import)。
process.env.ASH_RUNS_DIR = runs;

const IS_WINDOWS = process.platform === "win32";
let done = 0;
const group = (name: string) => { done++; process.stdout.write(`  ✓ ${name}\n`); };
const entries = (path: string | undefined) => (path ?? "").split(delimiter).filter(Boolean);

try {
  const { turnIdentityEnv, withoutTurnIdentity } = await import("../src/turn-identity.js");
  // 这条测试本身也可能是在某条 ash 任务的回合里被起来的(执行者跑自己的回归),继承来的 PATH
  // 里就带着那条任务的身份目录 —— 设/清两侧照设计都会把它筛掉(下面「别人家那段」那一节钉的
  // 就是这件事)。基线先洗掉它,「一段都不许动」比的才是同一份。
  process.env.PATH = entries(process.env.PATH).filter((entry) => !isTurnIdentityPathEntry(entry)).join(delimiter);
  const basePath = process.env.PATH;

  // ── ① 设:五个变量 + PATH 末尾多一段,文件内容与权限都对 ────────────────────
  {
    const id = { taskId: "taskA", turnToken: "turn1", directionToken: "dir1" };
    const env = turnIdentityEnv(id);
    assert.equal(env[ASH_TURN_IDENTITY_ENV.taskId], "taskA");
    assert.equal(env[ASH_TURN_IDENTITY_ENV.turnToken], "turn1");
    assert.equal(env[ASH_TURN_IDENTITY_ENV.turnTicket], "turn1", "别名那套也要设");
    const dir = join(runs, "taskA", ASH_TURN_IDENTITY_PATH_DIR, "turn1");
    const got = entries(env.PATH);
    assert.equal(got.at(-1), dir, "身份目录必须**追加在末尾**(盖不掉用户的命令)");
    assert.deepEqual(got.slice(0, -1), entries(basePath), "除此之外 PATH 一段都不许动");
    assert.ok(isTurnIdentityPathEntry(dir), "shared 那条判据要认得自己写出来的路径");
    const file = join(dir, ASH_TURN_IDENTITY_FILE);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      taskId: "taskA", turnToken: "turn1", directionToken: "dir1",
    });
    if (!IS_WINDOWS) {
      assert.equal(statSync(file).mode & 0o777, 0o600, "身份文件只许本人读");
      assert.equal(statSync(dir).mode & 0o777, 0o700, "目录也一样");
    }
    group("设:五个变量齐、身份目录追加在 PATH 末尾、文件 0600 目录 0700");
  }

  // ── ② 换回合就把上一回合那份删掉(残留子进程读到的是空,不是当前令牌)──────────
  {
    const prev = join(runs, "taskA", ASH_TURN_IDENTITY_PATH_DIR, "turn1");
    assert.ok(statSync(prev).isDirectory(), "前提:上一组刚写出来");
    const env = turnIdentityEnv({ taskId: "taskA", turnToken: "turn2", directionToken: "dir2" });
    assert.throws(() => statSync(prev), /ENOENT/, "上一回合那份必须被删掉");
    const now = join(runs, "taskA", ASH_TURN_IDENTITY_PATH_DIR, "turn2");
    assert.equal(entries(env.PATH).at(-1), now);
    assert.equal(
      (JSON.parse(readFileSync(join(now, ASH_TURN_IDENTITY_FILE), "utf8")) as { turnToken: string }).turnToken,
      "turn2",
    );
    group("换回合:上一回合那份当场作废(残留进程读到空,拿不到当前令牌)");
  }

  // ── ③ 两条任务各自一份,互不相认 ──────────────────────────────────────────
  {
    const a = entries(turnIdentityEnv({ taskId: "taskA", turnToken: "t", directionToken: "d" }).PATH).at(-1)!;
    const b = entries(turnIdentityEnv({ taskId: "taskB", turnToken: "t", directionToken: "d" }).PATH).at(-1)!;
    assert.notEqual(a, b, "任务 id 在路径里,两条任务不共用一份身份");
    assert.ok(statSync(a).isDirectory() && statSync(b).isDirectory(), "各自都还在(只清同任务的旧回合)");
    group("两条任务各一份:路径带任务 id,清旧回合只清自己那条任务的");
  }

  // ── ④ 继承来的**别人家**身份目录:设和清两侧都要筛掉 ───────────────────────
  //
  // 真实场景:ash 自己从一条 ash 任务里被起来,`process.env.PATH` 里就带着那条任务的身份
  // 目录。不筛掉的话,这台 ash 上每个 agent 都捡得到**那条任务**的身份(借来的身份比没有
  // 身份更糟 —— 它能拿着去调 complete_task)。
  {
    const foreign = join(runs, "someoneElse", ASH_TURN_IDENTITY_PATH_DIR, "theirTurn");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, ASH_TURN_IDENTITY_FILE), JSON.stringify({
      taskId: "someoneElse", turnToken: "theirTurn", directionToken: "theirDir",
    }), "utf8");
    const polluted = `${basePath}${delimiter}${foreign}`;
    const old = process.env.PATH;
    process.env.PATH = polluted;
    try {
      const set = turnIdentityEnv({ taskId: "taskC", turnToken: "mine", directionToken: "d" });
      assert.ok(!entries(set.PATH).includes(foreign), "设:别人家那段必须筛掉");
      assert.equal(entries(set.PATH).at(-1), join(runs, "taskC", ASH_TURN_IDENTITY_PATH_DIR, "mine"));

      const cleared = withoutTurnIdentity({ ASH_TASK_ID: "x", PATH: polluted });
      assert.equal(cleared.ASH_TASK_ID, undefined, "变量照旧要清");
      assert.ok(!entries(cleared.PATH).includes(foreign), "清:PATH 上那条通路也要摘掉");
      assert.deepEqual(entries(cleared.PATH), entries(basePath), "摘掉的只有那一段");

      // 覆盖层里**没有** PATH 这个键的那种调用(侧聊/预览/duet 现在就是这么调的)也要管:
      // 它们的底座是 `agentBaseEnv()`,而那份正是从被污染的 process.env 继承来的 ——
      // 覆盖层不显式给一个筛过的 PATH,摘掉的就只是变量、通路还通着。
      const overlay = withoutTurnIdentity({ ASH_TASK_ID: "x" } as Record<string, string | undefined>);
      assert.ok(!entries(overlay.PATH).includes(foreign), "没带 PATH 键的调用也要顶一个筛过的上去");
    } finally {
      process.env.PATH = old;
    }
    // 反过来:底座本来就干净时一个字都不动 —— 这几条路的行为必须与这条桥上线前逐字节一致。
    const untouched = withoutTurnIdentity({ ASH_TASK_ID: "x" } as Record<string, string | undefined>);
    assert.equal(untouched.PATH, undefined, "没得摘的时候不要凭空多一个 PATH 键");
    group("继承来的别人家身份目录:设和清两侧都筛掉,底座干净时一个字不动");
  }

  // ── ⑤ 读的那一侧(mcp/src/runtime.ts)真读得到,而且变量优先 ─────────────────
  //
  // 为什么要真 import 那个模块:这条桥的价值全在「只有 PATH 过得去」那种环境里成立,
  // 而那正是 copilot 的子进程环境。只断言 server 侧写对了文件,等于没验通。
  {
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "mcp", "src", "runtime.ts")).href;
    const identity = { taskId: "taskR", turnToken: "turnR", directionToken: "dirR" };
    turnIdentityEnv(identity);
    const dir = join(runs, "taskR", ASH_TURN_IDENTITY_PATH_DIR, "turnR");
    const keys = Object.values(ASH_TURN_IDENTITY_ENV);
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const oldPath = process.env.PATH;
    try {
      // ⒜ 一个身份变量都没有,只有 PATH ⇒ 从文件里读出来
      for (const k of keys) delete process.env[k];
      process.env.PATH = `${basePath}${delimiter}${dir}`;
      const viaPath = await import(`${url}?case=path`) as
        { SOURCE_TASK_ID: string; TURN_TOKEN: string; DIRECTION_TOKEN: string };
      assert.equal(viaPath.SOURCE_TASK_ID, "taskR", "只继承 PATH 时也要认出任务");
      assert.equal(viaPath.TURN_TOKEN, "turnR");
      assert.equal(viaPath.DIRECTION_TOKEN, "dirR");

      // ⒝ 变量在 ⇒ 变量赢(文件只是兜底,不许反过来盖掉变量)
      process.env[ASH_TURN_IDENTITY_ENV.taskId] = "fromEnv";
      process.env[ASH_TURN_IDENTITY_ENV.turnToken] = "envTurn";
      process.env[ASH_TURN_IDENTITY_ENV.directionToken] = "envDir";
      const viaEnv = await import(`${url}?case=env`) as
        { SOURCE_TASK_ID: string; TURN_TOKEN: string; DIRECTION_TOKEN: string };
      assert.equal(viaEnv.SOURCE_TASK_ID, "fromEnv", "变量优先");
      assert.equal(viaEnv.TURN_TOKEN, "envTurn");
      assert.equal(viaEnv.DIRECTION_TOKEN, "envDir");

      // ⒞ 目录已经被下一回合清掉 ⇒ 当没有身份(不是去捡别的回合那份)
      for (const k of keys) delete process.env[k];
      rmSync(dir, { recursive: true, force: true });
      const gone = await import(`${url}?case=gone`) as { SOURCE_TASK_ID: string; TURN_TOKEN: string };
      assert.equal(gone.SOURCE_TASK_ID, "", "读不到就是没有");
      assert.equal(gone.TURN_TOKEN, "");
    } finally {
      process.env.PATH = oldPath;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    group("读的那一侧:只有 PATH 时从文件读出身份、变量在时变量赢、目录没了就当没有");
  }

  console.log(`✅ 回合身份的 PATH 通路:${done} 组全过`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
