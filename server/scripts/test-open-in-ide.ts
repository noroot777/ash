// 「用 IDE 打开这个文件夹」的回归测试。
//
// 这条路跟 `/file/open` 一样,本质是**在 HTTP 上开了一个启动本机程序的入口**,所以要钉住
// 的不是「能打开」(那会在跑测试的机器上弹出一个 IDE 窗口),是那一圈拒绝:
//   ① `ideId` 必须出现在服务端自己的探测结果里 —— 清单之外的 id、以及任何想直接塞路径
//      的写法,一律 400 且不起任何进程;
//   ⓪ 以及一条**正面**的:启动器真的失败时接口必须说失败,而「没看到失败」不许冒充成功。
//      `spawn` 成功只证明启动器进程被创建了,证明不了 IDE 打开了;页面要是把它当成功,
//      用户会盯着一个没动静的屏幕以为自己点漏了。三种收场各钉一条:非零退出、**被信号
//      打死**(以前跟「退出码 0」混在一个判断里)、**盯完窗口还活着**(回 `launching`,
//      不是 `opened`)。全用一个受控的假 CLI 跑真进程验,不碰本机真实的编辑器;
//   ② 路径仍然走 `resolveTarget`,越界 / 不存在照样拒;
//   ③ 没有工作目录的任务 404;
//   ④ 清单本身的形状:id 不重名、每条至少给了一种平台的线索 —— 少了的那条在任何机器上
//      都永远探不到,而症状只是「我的 IDE 没出现」,没人会想到是清单写漏了;
//   ⑤ Windows 那半边的路径拼接(PATHEXT、`;` 分隔、`{LOCALAPPDATA}` 展开),以及**三档
//      启动各自拼成什么命令**——尤其是「目录永远是一个原样参数,不会变成命令或变量
//      表达式」这条不变量。这几条在 macOS 上跑多少次都走不到,所以按 windows.ts 的老办法
//      把纯函数导出来直接喂数据。
//
// 2026-10-20 这条不变量在 Windows 真机上验过了(192.168.1.187,PowerShell 5.1 /
// Node 22.20):`amp&ver`、`amp&md INJECTED`、`pct%TEMP%pct`、`with space`、`paren(x)`、
// `caret^x`、`中文目录` 七种目录名,经 .cmd 包装器档和原生 .exe 档各走一遍,两边收到的
// 都是**原样完整路径**,没有命令被额外执行,`%TEMP%` 也没有被展开。
//
// 那一轮还顺带得到一条教训,写在这里免得下一个人重复:**验证探针自己也会漏**。第一版
// 探针用 `echo CMD^|%~1` 记录参数,`%~1` 去掉引号后那个 `&` 在**探针自己**的那行上变成
// 了命令分隔符,于是「注入成功」的假象是探针造的。改成先 `set` 进变量再用延迟展开(或者
// 干脆交给 node 写记录)才看得到真相。
//
// 探测结果本身跟机器有关(这台装了什么),所以只断言形状不断言内容。
//
// 跑法(自带临时库):
//   npm -w server run test:open-in-ide
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb, requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-open-ide-"));
process.env.ASH_DB ||= join(stage, "open-ide.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
requireTmpDb("test-open-in-ide");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const { IDE_CATALOG } = await import("../src/openers/ide-catalog.js");
const { WIN_LAUNCHER_ENV, WIN_TARGET_ENV, commandCandidates, expandWindowsBase, launchPlan } =
  await import("../src/openers/ide.js");

await ensureSchema();
const app = new Hono();
app.route("/api", api);

const repo = join(stage, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
execFileSync("git", ["init", "-b", "main", repo]);

const ts = new Date().toISOString();
const common = {
  projectId: "proj",
  groupId: null,
  title: "IDE 打开测试",
  body: "",
  status: "backlog",
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  autoTitle: false,
  createdAt: ts,
  updatedAt: ts,
};

await db.insert(projects).values([
  { id: "proj", name: "IDE 打开测试项目", repoPath: repo, apiKeys: null, workflowId: null, createdAt: ts },
]);
await db.insert(projects).values([
  // 仓库路径指向一个不存在的目录 → 这个项目下的任务解析不出工作目录。
  { id: "proj-空", name: "没有工作目录", repoPath: join(stage, "不存在"), apiKeys: null, workflowId: null, createdAt: ts },
]);
await db.insert(tasks).values([
  { ...common, id: "task-main", parentId: null, mode: "single", useWorktree: false },
  { ...common, id: "task-无目录", projectId: "proj-空", parentId: null, mode: "single", useWorktree: false },
]);

const request = async (method: string, path: string, body?: unknown) => {
  const response = await app.request(`/api${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

const openInIde = (taskId: string, body: Record<string, unknown>) =>
  request("POST", `/tasks/${taskId}/file/open-in-ide`, body);

let failures = 0;
const check = (name: string, run: () => void | Promise<void>) => (async () => {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`);
  }
})();

// ── 清单本身 ───────────────────────────────────────────────────────────────
await check("清单里的 id 不重名", () => {
  const ids = IDE_CATALOG.map((spec) => spec.id);
  assert.equal(new Set(ids).size, ids.length, `重名：${ids.filter((id, i) => ids.indexOf(id) !== i).join("、")}`);
});

await check("每条都至少给了一种能在某个平台上找到它的线索", () => {
  for (const spec of IDE_CATALOG) {
    const clues = (spec.macApps?.length ?? 0) + (spec.commands?.length ?? 0)
      + (spec.windowsPaths?.length ?? 0) + (spec.linuxPaths?.length ?? 0);
    assert.ok(clues > 0, `${spec.id} 一条线索都没有，在任何机器上都永远探不到`);
  }
});

await check("macOS 那一列写的是 .app 名字，不是路径", () => {
  for (const spec of IDE_CATALOG) {
    for (const app of spec.macApps ?? []) {
      assert.ok(app.endsWith(".app"), `${spec.id} 的 ${app} 不是 .app`);
      assert.ok(!app.includes("/"), `${spec.id} 的 ${app} 带了路径——扫描目录由 ide.ts 决定`);
    }
  }
});

// ── Windows 那半边的拼接（在 macOS 上也必须测得到） ────────────────────────
const winEnv = {
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  PATH: "C:\\Windows\\system32;C:\\Users\\me\\AppData\\Local\\Programs\\cursor",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
};

await check("Windows: PATH 按分号切，每个目录再按 PATHEXT 补后缀", () => {
  const candidates = commandCandidates("code", winEnv, true);
  assert.deepEqual(candidates.slice(0, 2), [
    "C:\\Windows\\system32\\code.COM",
    "C:\\Windows\\system32\\code.EXE",
  ]);
  assert.ok(
    candidates.includes("C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\code.CMD"),
    "`code` 在 Windows 上实际是 code.cmd，漏了这一档等于在那边永远探不到 VS Code",
  );
  assert.equal(candidates.length, 8, "2 个目录 × 4 个后缀");
});

await check("非 Windows: 不补后缀，按冒号切", () => {
  // 这条**在 Windows 宿主上也必须过**：分隔符和 join 以前各有一半跟着宿主走，于是在
  // Windows 真机上它拿 `;` 去切冒号路径、再用 win32.join 拼，结果是
  // `\\usr\\local\\bin:\\usr\\bin\\code`（第 2 轮审查 N2 实测）。只参数化一半，跨平台
  // 那一档就只能在对应宿主上验证——而那正是这个函数存在的理由。
  const candidates = commandCandidates("code", { PATH: "/usr/local/bin:/usr/bin" }, false);
  assert.deepEqual(candidates, ["/usr/local/bin/code", "/usr/bin/code"]);
});

await check("Windows: 占位符展开成真实目录，正斜杠归一成反斜杠", () => {
  assert.equal(
    expandWindowsBase("{LOCALAPPDATA}/Programs/cursor/Cursor.exe", winEnv),
    "C:\\Users\\me\\AppData\\Local\\Programs\\cursor\\Cursor.exe",
  );
  assert.equal(
    expandWindowsBase("{PROGRAMFILESX86}/Microsoft VS Code/Code.exe", winEnv),
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
  );
});

await check("Windows: 变量不存在时判定这条候选不可用，不拼出带花括号的假路径", () => {
  const expanded = expandWindowsBase("{LOCALAPPDATA}/Programs/x.exe", { PATHEXT: "", PATH: "" });
  assert.equal(expanded, null);
});

await check("清单里 Windows 那一列用的占位符都是认得出来的那几个", () => {
  const known = new Set(["LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILESX86", "USERPROFILE"]);
  for (const spec of IDE_CATALOG) {
    for (const template of spec.windowsPaths ?? []) {
      for (const [, name] of template.matchAll(/\{([A-Z0-9]+)\}/g)) {
        assert.ok(known.has(name!), `${spec.id} 用了认不出的占位符 {${name}}，那条路径永远展不开`);
      }
    }
  }
});

// ── 启动命令：目录永远是一个原样参数 ──────────────────────────────────────
// Windows 上 `C:\review\project&ver` 是合法目录名。它一旦拼进 cmd 的命令行，`&ver` 就
// 是第二条命令；`%TEMP%` 那种名字则会被展开成别的路径，打开的根本不是用户点的那个。
const NASTY = "C:\\review\\project&ver %TEMP% (x)";

await check("Windows 原生 exe 直接起，不经过 cmd", () => {
  const plan = launchPlan("exec", "C:\\Programs\\cursor\\Cursor.exe", NASTY);
  assert.equal(plan.file, "C:\\Programs\\cursor\\Cursor.exe");
  assert.deepEqual(plan.args, [NASTY], "目录是一个 argv 元素，中间没有 shell 再解释一遍");
  assert.equal(plan.verbatim, false);
  assert.ok(plan.waitMs > 0 && plan.waitMs <= 3000, "直接起的进程只盯早夭窗口，不能等它退出");
});

await check("Windows 批处理入口：路径不出现在命令行里，只走环境变量", () => {
  const plan = launchPlan("winshell", "C:\\Toolbox\\scripts\\idea.cmd", NASTY);
  assert.equal(plan.file, "cmd.exe");
  const line = plan.args.join(" ");
  assert.ok(!line.includes(NASTY), `目录泄进了命令行：${line}`);
  assert.ok(!line.includes("&ver") && !line.includes("(x)"), "元字符一个都不该出现在命令行上");
  assert.ok(!line.includes("idea.cmd"), "启动器路径同样不拼进去——它也可能带元字符");
  assert.deepEqual(plan.env, {
    [WIN_LAUNCHER_ENV]: "C:\\Toolbox\\scripts\\idea.cmd",
    [WIN_TARGET_ENV]: NASTY,
  });
  assert.ok(plan.args.includes("/d"), "/d 跳过注册表里挂的 AutoRun 脚本");
  assert.ok(plan.args.includes("/s"), "/s 锁定「去掉首尾一对引号」这条解析规则");
  assert.equal(plan.verbatim, true, "命令行是我们自己写死的，别让 Node 再加一层引号");
  // 两个占位都必须带着双引号：展开是单遍的（里面的 % 不会被二次扫描），
  // 引号则让展开出来的 & | > 留在参数里而不是变成命令分隔符。
  assert.ok(plan.args.some((arg) => arg.includes(`"%${WIN_TARGET_ENV}%"`)), "目标占位必须被双引号包住");
  assert.ok(plan.args.some((arg) => arg.includes(`"%${WIN_LAUNCHER_ENV}%"`)), "启动器占位必须被双引号包住");
  assert.ok(plan.waitMs >= 10_000, "包装器交代完就退出，给足时间等它的退出码");
});

await check("macOS 走 open -a，退出码可信，算短命启动器", () => {
  const plan = launchPlan("app", "/Applications/Zed.app", "/Users/me/code/a&b");
  assert.deepEqual([plan.file, ...plan.args], ["open", "-a", "/Applications/Zed.app", "/Users/me/code/a&b"]);
  assert.equal(plan.verbatim, false);
  assert.ok(plan.waitMs >= 10_000, "open 几百毫秒就退出，值得等它的退出码");
});

await check("清单里 Windows 那一列的 .cmd / .bat 都会落到 shell 档，其余不进 shell", () => {
  // 这一条锁住分档依据本身：哪天有人往清单里加一条 .bat，它不能被当成原生 exe 直接 spawn
  // （Node 18.20 起直接拒），也不能反过来让 .exe 白白过一趟 cmd。
  const plan = launchPlan("winshell", "C:\\x\\code.cmd", "C:\\dir");
  assert.equal(plan.file, "cmd.exe");
  assert.equal(launchPlan("exec", "C:\\x\\Code.exe", "C:\\dir").file, "C:\\x\\Code.exe");
});

// ── 探测 ───────────────────────────────────────────────────────────────────
await check("GET /ides 回的每条都带 id / name / detail，且 id 来自清单", async () => {
  const result = await request("GET", "/ides");
  assert.equal(result.status, 200);
  const ides = result.json.ides as { id: string; name: string; detail: string }[];
  assert.ok(Array.isArray(ides), "ides 得是数组");
  const known = new Set(IDE_CATALOG.map((spec) => spec.id));
  for (const ide of ides) {
    assert.ok(known.has(ide.id), `${ide.id} 不在清单里`);
    assert.ok(ide.name && ide.detail, `${ide.id} 缺 name 或 detail`);
  }
  // 一个都没探到时必须说句人话，否则界面上是一张空菜单。
  assert.equal(ides.length === 0, typeof result.json.note === "string" && result.json.note.length > 0);
});

// ── 拒绝 ───────────────────────────────────────────────────────────────────
await check("清单外的 ideId 一律 400", async () => {
  for (const ideId of ["", "没这个", "/Applications/Visual Studio Code.app", "../../bin/sh"]) {
    const result = await openInIde("task-main", { path: "", ideId });
    assert.equal(result.status, 400, `${ideId || "(空)"} 应当被拒`);
  }
});

await check("越界路径在校验 ideId 之前就被拦住", async () => {
  const result = await openInIde("task-main", { path: "../逃出去", ideId: "vscode" });
  assert.equal(result.status, 400);
});

await check("没有工作目录的任务 404", async () => {
  const result = await openInIde("task-无目录", { path: "", ideId: "vscode" });
  assert.equal(result.status, 404);
});

// ── 启动结果三档（跑真进程，但只跑我们自己造的那个） ──────────────────────
// 不碰本机真实编辑器：往 PATH 前面塞一个假的 `codium`，让探测从 commands 那一列命中它。
// 它把收到的参数写进文件，再按 FAKE_IDE_MODE 选一种收场，于是「传对了哪个目录」和「三种
// 收场各自被怎么报回去」能在同一个真进程上验完。
//
// 为什么非得跑真进程：这三档的区别全在 `child.on("exit")` 拿到的 `(code, signal)` 上，
// 纯函数测不到——被信号打死那一档以前正是栽在这里（`code === null` 被当成了成功）。
if (process.platform === "win32") {
  console.log("⊘ 启动器真进程用例在 Windows 上跳过（假 CLI 是 sh 脚本）");
} else {
  const fakeBin = join(stage, "bin");
  const argsLog = join(stage, "launched-args.txt");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "codium"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "${argsLog}"`,
      'case "${FAKE_IDE_MODE:-ok}" in',
      "  fail) exit 23 ;;",
      // 自杀式信号退出 = 被安全软件 / OOM killer 打死的那一类
      "  signal) kill -TERM $$; sleep 5 ;;",
      // 活过早夭窗口再失败：这正是「等一会儿没动静就说已打开」会漏掉的那一档
      "  slowfail) sleep 3; exit 23 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "codium"), 0o755);
  process.env.PATH = `${fakeBin}:${process.env.PATH ?? ""}`;

  // 真装了 VSCodium 的机器上探测会先命中那一个，那就别拿用户的编辑器做实验。
  const probe = await request("GET", "/ides?refresh=1");
  const hit = (probe.json.ides as { id: string; detail: string }[]).find((ide) => ide.id === "vscodium");
  if (hit?.detail !== join(fakeBin, "codium")) {
    console.log("⊘ 启动器真进程用例跳过：这台机器上 vscodium 命中的是真实安装");
  } else {
    await check("启动器以非零退出 → 接口回失败，不说「已打开」", async () => {
      process.env.FAKE_IDE_MODE = "fail";
      const result = await openInIde("task-main", { path: "src", ideId: "vscodium" });
      assert.equal(result.status, 500, `应当失败，实际 ${result.status}：${JSON.stringify(result.json)}`);
      assert.match(String(result.json.error), /23/, "错误里要带上退出码，否则用户无从查起");
      assert.ok(!("ok" in result.json), "失败的回执里不该还有 ok");
    });

    await check("启动器被信号打死 → 同样是失败，不能当成退出码 0", async () => {
      process.env.FAKE_IDE_MODE = "signal";
      const result = await openInIde("task-main", { path: "src", ideId: "vscodium" });
      assert.equal(result.status, 500, `应当失败，实际 ${result.status}：${JSON.stringify(result.json)}`);
      assert.match(String(result.json.error), /信号/, "要说清是被信号终止的，不然没法查是谁杀的");
    });

    await check("活过早夭窗口但还没确认 → 回 launching，不是 opened", async () => {
      process.env.FAKE_IDE_MODE = "slowfail";
      const started = Date.now();
      const result = await openInIde("task-main", { path: "src", ideId: "vscodium" });
      assert.equal(result.status, 200, "没看到失败就不该报错——它可能真的是个编辑器");
      assert.equal(
        result.json.status,
        "launching",
        "这一档服务端什么确认都没拿到，报 opened 就是让页面去说一件没发生的事",
      );
      assert.ok(Date.now() - started < 2500, "只盯早夭窗口，不能一路等到它三秒后失败");
    });

    await check("启动器正常退出 → opened，且收到的就是那个子目录的绝对路径", async () => {
      process.env.FAKE_IDE_MODE = "ok";
      const result = await openInIde("task-main", { path: "src", ideId: "vscodium" });
      assert.equal(result.status, 200);
      assert.equal(result.json.name, "VSCodium");
      assert.equal(result.json.status, "opened", "拿到 0 退出码才是确认");
      assert.equal(readFileSync(argsLog, "utf8").trim(), join(repo, "src"));
    });
    delete process.env.FAKE_IDE_MODE;
  }
}

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} 条没过`);
  process.exit(1);
}
console.log("\n全部通过");
process.exit(0);
