// 真库测试不得启动真智能体。这道闸放在最底层 spawn 边界，所以普通管道、
// 输出落盘的 detached 管道、常驻会话都绕不过。
//
// 放行按路径认（NAVI_TEST_AGENT_BIN）：测试只能起自己铺的那几个可执行文件。后半段钉的就是
// 「收尾先把 PATH 还原、排着的任务这时才起跑」——那一刻同一个名字解析到的是机器上真的 CLI，
// 必须被闸住，一次都不许跑起来。再后面钉「验的和起的是同一个文件」：解析结果是相对路径时，
// 校验按本进程的 cwd 认、子进程按任务的 cwd 找，两处各有一个同名文件就会验一个起另一个。
// 最后两段往文件系统里插时序：闸刚查完、文件才装上；闸刚认完、路径中途的软链就改指别处。
// 放行交回的只能是核验过的那条绝对路径，所以两种都起不到放行范围之外。
// Run: npm -w server run test:agent-spawn-guard
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "navi-agent-guard-"));
const IS_WINDOWS = process.platform === "win32";
const originalPath = process.env.PATH;
const originalCwd = process.cwd();
process.env.NAVI_RUNS_DIR = join(root, "runs");
delete process.env.NAVI_ALLOW_REAL_AGENT;
delete process.env.NAVI_TEST_AGENT_BIN;

const { spawnAgent } = await import("../src/executors/spawn.js");
const { detachedPathsFor, spawnControllableForRun, spawnDetachedAgent, spawnForRun } = await import("../src/executors/detached.js");
type Child = ReturnType<typeof spawnAgent>;

function errorOf(child: Child): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("禁启错误没有送达")), 2000);
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
  });
}

function exitOf(child: Child): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("起来的进程没有按时退出")), 10_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

/** 一跑就留下记号的桩：记号在 = 它真的被起起来过。 */
function stub(dir: string, name: string): { file: string; ran: string } {
  mkdirSync(dir, { recursive: true });
  const ran = join(dir, `${name}.ran`);
  const file = join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  writeFileSync(file, IS_WINDOWS ? `@echo ran> "${ran}"\r\n` : `#!/bin/sh\necho ran > "${ran}"\n`, { mode: 0o755 });
  return { file, ran };
}

/**
 * 在一次起跑里往文件系统插一步：`calls` 里的调用碰到 `target` 的头一次，原调用照常做完（返回或抛错）
 * 之后、结果交回调用方之前，先跑 `then`。模拟的是「两次系统调用之间外面有人动了文件」，起跑调用一返回就撤掉。
 */
function interleave(calls: ("accessSync" | "statSync" | "realpathSync")[], target: string, then: () => void, launch: () => Child): Child {
  const originals = calls.map((name) => [name, fs[name]] as const);
  let fired = false;
  for (const [name, original] of originals) {
    (fs as any)[name] = (path: unknown, ...rest: unknown[]) => {
      try {
        return (original as any)(path, ...rest);
      } finally {
        if (!fired && String(path) === target) { fired = true; then(); }
      }
    };
  }
  syncBuiltinESMExports();
  try {
    return launch();
  } finally {
    for (const [name, original] of originals) (fs as any)[name] = original;
    syncBuiltinESMExports();
    assert.ok(fired, `这次起跑没有碰到 ${target}，时序没插进去`);
  }
}

const detach = (bin: string, turn: string) =>
  spawnDetachedAgent(root, bin, [], "", detachedPathsFor(root, "session", turn)) as Child;
const BLOCKED = /测试隔离环境禁止启动真执行器/;

try {
  // —— 什么都没声明：一律不起。
  assert.match(await errorOf(spawnAgent(root, process.execPath, ["-e", "process.exit(0)"], "")), BLOCKED);
  assert.match(await errorOf(detach(process.execPath, "undeclared")), BLOCKED);
  console.log("✓ 没声明自己铺了什么：管道与落盘两种起法都不起");

  // —— 声明了自己铺的目录：解析到里面的才起。fake 是测试铺的，host 充当机器上真装着的那份。
  const fake = join(root, "fake-bin");
  const host = join(root, "host-bin");
  const fakeClaude = stub(fake, "claude");
  const hostClaude = stub(host, "claude");
  const hostCodex = stub(host, "codex");
  process.env.NAVI_TEST_AGENT_BIN = fake;
  process.env.PATH = [fake, host, originalPath ?? ""].join(delimiter);
  assert.equal(await exitOf(spawnAgent(root, "claude", [], "")), 0);
  assert.ok(existsSync(fakeClaude.ran), "铺的假 claude 应当真的跑起来");
  assert.ok(!existsSync(hostClaude.ran));
  // 没铺桩的名字落到机器上那份：不起。
  assert.match(await errorOf(spawnAgent(root, "codex", [], "")), BLOCKED);
  assert.ok(!existsSync(hostCodex.ran), "没铺桩的名字不许落到机器上那份去");
  console.log("✓ 声明了假目录：里面的照常起，没铺桩的名字解析到别处就不起");

  // —— 收尾先还原了 PATH、放行还开着，晚到的起跑：同一个名字此刻解析到机器上那份，不起。
  rmSync(fakeClaude.ran);
  process.env.PATH = [host, originalPath ?? ""].join(delimiter);
  const late = await errorOf(spawnAgent(root, "claude", [], ""));
  assert.match(late, BLOCKED);
  assert.ok(late.includes(hostClaude.file), `禁启错误要说出解析到了哪：${late}`);
  assert.match(await errorOf(detach("claude", "late")), BLOCKED);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!existsSync(hostClaude.ran) && !existsSync(fakeClaude.ran), "PATH 还原后晚到的起跑一次都不许跑起来");
  console.log("✓ PATH 还原之后才轮到的起跑：解析到机器上那份，管道与落盘两种起法都不起");

  // —— 声明的是单个文件：只放行它，同目录的别的不沾光（node 旁边就是真 CLI 的机器很常见）。
  process.env.NAVI_TEST_AGENT_BIN = hostCodex.file;
  assert.equal(await exitOf(spawnAgent(root, "codex", [], "")), 0);
  assert.match(await errorOf(spawnAgent(root, "claude", [], "")), BLOCKED);
  assert.ok(existsSync(hostCodex.ran) && !existsSync(hostClaude.ran));
  // 多项用 PATH 分隔符；目录写成另一种等价路径（macOS 的临时目录是软链）照样认。
  process.env.NAVI_TEST_AGENT_BIN = [process.execPath, realpathSync(fake)].join(delimiter);
  process.env.PATH = [fake, host, originalPath ?? ""].join(delimiter);
  assert.equal(await exitOf(spawnAgent(root, process.execPath, ["-e", "process.exit(0)"], "")), 0);
  assert.equal(await exitOf(spawnAgent(root, "claude", [], "")), 0);
  assert.match(await errorOf(spawnAgent(root, "codex", [], "")), BLOCKED);
  console.log("✓ 单个文件只放行它自己；多项、等价路径照常认");

  // —— 验的和起的是同一个文件。本进程 cwd 下的 rel/claude 在放行范围里，任务 cwd 下还有一个同名的：
  //    命令写成相对路径、PATH 里有相对目录，三种起法起的都必须是通过校验的那一个。
  const stage = join(root, "stage");
  const work = join(stage, "work");
  const vetted = stub(join(stage, "rel"), "claude");
  const impostor = stub(join(work, "rel"), "claude");
  process.env.NAVI_TEST_AGENT_BIN = join(stage, "rel");
  process.env.PATH = ["rel", originalPath ?? ""].join(delimiter);
  const launches: [string, () => Child][] = [
    ["管道，命令写成相对路径", () => spawnForRun(work, join("rel", "claude"), [], "")],
    ["管道，PATH 里是相对目录", () => spawnForRun(work, "claude", [], "")],
    ["落盘，PATH 里是相对目录", () => spawnForRun(work, "claude", [], "", undefined, detachedPathsFor(root, "session", "relative"))],
    ["可重连 stdin，PATH 里是相对目录",
      () => spawnControllableForRun(work, "claude", [], "", undefined, detachedPathsFor(root, "session", "relative-stdin"))],
  ];
  process.chdir(stage);
  try {
    for (const [label, launch] of launches) {
      rmSync(vetted.ran, { force: true });
      assert.equal(await exitOf(launch()), 0, label);
      assert.ok(existsSync(vetted.ran), `${label}：通过校验的那个应当跑起来`);
      assert.ok(!existsSync(impostor.ran), `${label}：起的不是通过校验的那个，是任务目录下的同名文件`);
    }
  } finally {
    process.chdir(originalCwd);
  }
  console.log("✓ 解析结果是相对路径：管道、落盘、可重连 stdin 起的都是通过校验的那一个");

  // —— 闸查的那一下还没有，刚查完才装上：放行范围之外的东西，不能靠「第一次没查到」混过去。
  process.env.NAVI_TEST_AGENT_BIN = fake;
  process.env.PATH = [fake, originalPath ?? ""].join(delimiter);
  const ghostFile = join(host, IS_WINDOWS ? "ghost.cmd" : "ghost");
  const appearing: [string, () => Child][] = [
    ["管道", () => spawnAgent(root, ghostFile, [], "")],
    ["落盘", () => detach(ghostFile, "appearing")],
    ["可重连 stdin", () => spawnControllableForRun(root, ghostFile, [], "", undefined, detachedPathsFor(root, "session", "appearing-stdin"))],
  ];
  for (const [label, launch] of appearing) {
    rmSync(ghostFile, { force: true });
    const ghost = { ran: join(host, "ghost.ran") };
    const child = interleave(["accessSync", "statSync"], ghostFile, () => { stub(host, "ghost"); }, launch);
    assert.match(await errorOf(child), /找不到/, label);
    assert.ok(existsSync(ghostFile), `${label}：文件应当已经在闸查完之后装上了`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!existsSync(ghost.ran), `${label}：闸没查到、随后才出现的文件被起起来了`);
  }
  console.log("✓ 闸查完文件才出现：管道、落盘、可重连 stdin 都报找不到，一次不起");

  // —— 闸刚认完，路径中途的软链改指机器上那份：起的仍是认过的那个位置。
  if (!IS_WINDOWS) {
    const link = join(root, "link-bin");
    const point = (to: string) => { rmSync(link, { force: true }); symlinkSync(to, link); };
    process.env.PATH = [link, originalPath ?? ""].join(delimiter);
    const retargeted: [string, () => Child][] = [
      ["管道", () => spawnAgent(root, "claude", [], "")],
      ["落盘", () => detach("claude", "retargeted")],
      ["可重连 stdin", () => spawnControllableForRun(root, "claude", [], "", undefined, detachedPathsFor(root, "session", "retargeted-stdin"))],
    ];
    for (const [label, launch] of retargeted) {
      rmSync(fakeClaude.ran, { force: true });
      point(fake);
      assert.equal(await exitOf(interleave(["realpathSync"], link, () => point(host), launch)), 0, label);
      assert.ok(existsSync(fakeClaude.ran), `${label}：认过的那个应当跑起来`);
      assert.ok(!existsSync(hostClaude.ran), `${label}：软链改指之后起到了放行范围之外`);
    }
    console.log("✓ 认完之后软链改指别处：管道、落盘、可重连 stdin 起的仍是认过的位置");
  }

  // —— live 脚本的整体放行仍然是整体放行。
  delete process.env.NAVI_TEST_AGENT_BIN;
  process.env.NAVI_ALLOW_REAL_AGENT = "1";
  assert.equal(await exitOf(spawnAgent(root, process.execPath, ["-e", "process.exit(0)"], "")), 0);
  console.log("agent spawn guard ok");
} finally {
  delete process.env.NAVI_ALLOW_REAL_AGENT;
  delete process.env.NAVI_TEST_AGENT_BIN;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
}
