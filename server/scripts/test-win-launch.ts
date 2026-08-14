// Windows 上「命令名 → 真正能 spawn 的东西」这条链（platform.ts / bin-resolve.ts /
// win-command.ts），在 macOS 上就能跑。
//
// 为什么值得单独钉：这条链上的四个 Windows 专属分支，错了都不是「不好看」而是
// 「一个 CLI 都起不来」或者「起的是别的命令」，而它们在开发机上永远走不到 ——
// 只能靠伪造 process.platform 把真实分支跑一遍。这也是 platform.ts 里 PATH_DELIMITER /
// splitPathSegments 存在的理由：`path.delimiter` 由 Node 启动时的真实平台定死，
// 没法跟 IS_WINDOWS 一起翻转，用它写的代码在这里就测不到。
//
// 覆盖：
//   1. PATH 按 `;` 拆（按 `:` 拆会把 `C:\Users\…` 从盘符处切两半）
//   2. 按 PATHEXT 补扩展名，且顺序即优先级（.exe 赢 .cmd）
//   3. 「是个文件」而不是 accessSync(X_OK)（后者在 Windows 上恒为真）
//   4. npm `.cmd` 垫片拆封成 `node <script>`，拆不开才退 cmd.exe
//   5. cmd.exe 的参数引号规则（CVE-2024-24576 那套），含换行直接拒
//   6. augmentedEnv 去掉 Path/PATH 的大小写重影
// 跑：npm -w server run test:win-launch
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 任何 src 模块之前翻平台：IS_WINDOWS 是模块加载期算的。
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

const stage = mkdtempSync(join(tmpdir(), "harness-win-launch-"));

/** npm 在 Windows 上生成的 bin 垫片，原样照抄结构（末行那条脚本路径是重点）。 */
function npmShim(scriptRel: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${scriptRel}" %*`,
  ].join("\r\n");
}

try {
  const binDir = join(stage, "npm");
  const sysDir = join(stage, "System32");
  const cliDir = join(binDir, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(sysDir, { recursive: true });

  const cliJs = join(cliDir, "cli.js");
  writeFileSync(cliJs, "// 真正要跑的东西\n");
  writeFileSync(join(binDir, "claude.cmd"), npmShim("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
  // 垫片指向的脚本不存在 → 拆不开，必须退 cmd.exe 而不是拼一条跑不通的 node 命令
  writeFileSync(join(binDir, "ghost.cmd"), npmShim("node_modules\\gone\\cli.js"));
  // 手写批处理，压根没有 %dp0% 脚本行
  writeFileSync(join(binDir, "plain.bat"), "@echo off\r\necho hi\r\n");
  writeFileSync(join(binDir, "notes.txt"), "不是命令");
  writeFileSync(join(sysDir, "node.exe"), "MZ");
  writeFileSync(join(sysDir, "node.cmd"), "@echo off\r\n");
  // 目录也叫 fake.exe：accessSync(X_OK) 在 Windows 上对它同样返回真
  mkdirSync(join(binDir, "fake.exe"), { recursive: true });

  // 故意带盘符风格的段落：按 `:` 拆会把它切碎
  process.env.PATH = ["C:\\Windows\\System32", sysDir, binDir].join(";");
  delete process.env.PATHEXT; // 用默认值 .COM;.EXE;.BAT;.CMD

  const { PATH_DELIMITER, splitPathList, splitPathSegments } = await import("../src/platform.js");
  const { augmentedEnv, resolveBin, resolveLaunch } = await import("../src/executors/bin-resolve.js");
  const { UnquotableArgumentError } = await import("../src/executors/win-command.js");

  // ── 1. PATH 拆分 ───────────────────────────────────────────────────────────
  assert.equal(PATH_DELIMITER, ";", "Windows 的 PATH 分隔符是 ;");
  assert.deepEqual(
    splitPathList("C:\\Windows\\System32;C:\\tools\\bin"),
    ["C:\\Windows\\System32", "C:\\tools\\bin"],
    "盘符里的冒号不能被当成分隔符",
  );
  assert.deepEqual(splitPathSegments("node_modules\\a\\b.js"), ["node_modules", "a", "b.js"]);
  assert.deepEqual(splitPathSegments("node_modules/a/b.js"), ["node_modules", "a", "b.js"]);

  // ── 2. 扩展名补全与优先级 ──────────────────────────────────────────────────
  assert.equal(resolveBin("claude"), join(binDir, "claude.cmd"), "裸名要按 PATHEXT 补出 .cmd");
  assert.equal(resolveBin("node"), join(sysDir, "node.exe"), "PATHEXT 顺序即优先级：.exe 赢 .cmd");
  assert.equal(resolveBin("claude.cmd"), join(binDir, "claude.cmd"), "自带扩展名就别再拼 claude.cmd.exe");
  assert.equal(resolveBin("nosuchcli"), null);

  // ── 3. 「是个文件」而不是 X_OK ────────────────────────────────────────────
  assert.equal(resolveBin("notes"), null, ".txt 不在 PATHEXT 里，不是命令");
  assert.equal(resolveBin("fake"), null, "同名目录不能被当成可执行文件");

  // 带路径但没写扩展名的形式同样要补
  assert.equal(resolveBin(join(binDir, "claude")), join(binDir, "claude.cmd"));
  assert.equal(resolveBin(join(binDir, "fake")), null, "带路径时同样只认文件");

  // ── 4. 垫片拆封 ───────────────────────────────────────────────────────────
  const claude = resolveLaunch("claude", ["-p", "hi"]);
  assert.ok(claude);
  assert.equal(claude.path, join(binDir, "claude.cmd"), "path 仍指向磁盘上命中的那个文件");
  assert.equal(claude.file, process.execPath, "拆开后直接用本进程的 node");
  assert.deepEqual(claude.args, [cliJs, "-p", "hi"]);
  assert.equal(claude.windowsVerbatimArguments, undefined, "不过 cmd.exe 就不该开 verbatim");

  const exe = resolveLaunch("node", ["-v"]);
  assert.ok(exe);
  assert.equal(exe.file, join(sysDir, "node.exe"));
  assert.deepEqual(exe.args, ["-v"]);
  assert.equal(exe.windowsVerbatimArguments, undefined);

  // ── 5. 退回 cmd.exe 的引号规则 ────────────────────────────────────────────
  for (const bin of ["plain", "ghost"]) {
    const plan = resolveLaunch(bin, ["a b"]);
    assert.ok(plan, `${bin} 应该能解析`);
    assert.equal(plan.file, "cmd.exe");
    assert.equal(plan.windowsVerbatimArguments, true, "verbatim 必须开，否则 Node 会再转义一轮");
    assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"], "/d 跳过 AutoRun，/s 只剥最外层引号");
  }

  const quoted = resolveLaunch("plain", ["a b", 'q"x', "C:\\dir\\", ""]);
  assert.ok(quoted);
  // 逐条对照 CVE-2024-24576 那套规则：整体加引号、内部 `"` 翻倍、结尾反斜杠翻倍、
  // 空参数也必须留一对引号（否则解析时整个消失）。
  const expectedLine = `"${join(binDir, "plain.bat")}" "a b" "q""x" "C:\\dir\\\\" ""`;
  assert.equal(quoted.args[3], `"${expectedLine}"`);

  assert.throws(
    () => resolveLaunch("plain", ["line1\nline2"]),
    (e: unknown) => e instanceof UnquotableArgumentError,
    "含换行的参数在 cmd.exe 里无法转义，只能拒收",
  );
  // 能直接 spawn 的路径不过 cmd.exe，换行就不是问题，不该被拒
  assert.ok(resolveLaunch("node", ["-e", "console.log(1)\nconsole.log(2)"]));

  // ── 6. PATH 的大小写重影 ──────────────────────────────────────────────────
  process.env.Path = "C:\\shadow";
  const env = augmentedEnv();
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === "path");
  assert.deepEqual(pathKeys, ["PATH"], "只能留一个 PATH 键，否则子进程拿哪个由实现定");
  assert.ok(env.PATH?.startsWith(process.env.PATH!), "补充目录追加在原 PATH 之后");
  delete process.env.Path;

  console.log("✅ Windows 启动链（PATH/PATHEXT/垫片拆封/cmd 引号）全部通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
