// 「用 IDE 打开这个文件夹」的回归测试。
//
// 这条路跟 `/file/open` 一样,本质是**在 HTTP 上开了一个启动本机程序的入口**,所以要钉住
// 的不是「能打开」(那会在跑测试的机器上弹出一个 IDE 窗口),是那一圈拒绝:
//   ① `ideId` 必须出现在服务端自己的探测结果里 —— 清单之外的 id、以及任何想直接塞路径
//      的写法,一律 400 且不起任何进程;
//   ② 路径仍然走 `resolveTarget`,越界 / 不存在照样拒;
//   ③ 没有工作目录的任务 404;
//   ④ 清单本身的形状:id 不重名、每条至少给了一种平台的线索 —— 少了的那条在任何机器上
//      都永远探不到,而症状只是「我的 IDE 没出现」,没人会想到是清单写漏了;
//   ⑤ Windows 那半边的路径拼接(PATHEXT、`;` 分隔、`{LOCALAPPDATA}` 展开)。这几条在
//      macOS 上跑多少次都走不到,所以按 windows.ts 的老办法把纯函数导出来直接喂数据。
//      **仍未真机验证的是 `cmd /c start` 那一步**(2026-10-16:192.168.1.187 不在网上)。
//
// 探测结果本身跟机器有关(这台装了什么),所以只断言形状不断言内容。
//
// 跑法(自带临时库):
//   npm -w server run test:open-in-ide
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { commandCandidates, expandWindowsBase } = await import("../src/openers/ide.js");

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

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} 条没过`);
  process.exit(1);
}
console.log("\n全部通过");
process.exit(0);
