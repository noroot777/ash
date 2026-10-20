// Windows「用哪个应用打开」的注册表解析 + 命令行拼装。
//
// 这条测试在 macOS/Linux 上也必须能跑：真正碰注册表的只有 windows.ts 里那段 PowerShell，
// 解析和拼装都是纯函数，所以拿真实机器上抄下来的注册表输出当样本喂进去。开发机上没有
// 注册表可查，没有这条测试的话，`%1` 替换、带空格的路径、默认应用这些地方全靠肉眼。
import assert from "node:assert/strict";
import {
  WIN_OPEN_TARGET_ENV,
  buildWindowsCommand,
  parseRegistryScan,
  registryScript,
  toWindowsProbe,
  windowsDefaultOpenCommand,
} from "../src/openers/windows.js";

// 样本照着真机上 .md 的注册表长相写：VS Code 是 ProgID 关联、Notepad++ 走 OpenWithList
// 落到 Applications\ 下、最后一个是没有 %1 占位符的老式条目。
const SAMPLE = [
  "D\tVSCode.md",
  "A\tVSCode.md\tVisual Studio Code\t\"C:\\Program Files\\Microsoft VS Code\\Code.exe\" \"%1\"",
  "A\tApplications\\notepad++.exe\tNotepad++ : a free (GNU) source code editor\t\"C:\\Program Files\\Notepad++\\notepad++.exe\" \"%1\"",
  "A\tApplications\\notepad.exe\t记事本\t%SystemRoot%\\system32\\NOTEPAD.EXE %1",
  "A\tLegacy.md\t老式条目\t\"C:\\Tools\\viewer.exe\" --view",
].join("\r\n");

const scan = parseRegistryScan(SAMPLE);
assert.equal(scan.defaultId, "VSCode.md", "D 行给的是默认 ProgID");
assert.equal(scan.entries.length, 4, "四个条目都要解析出来");

const probe = toWindowsProbe("md", scan);
assert.equal(probe.platform, "win32");
assert.equal(probe.canReveal, true, "Windows 上「在文件夹中显示」一直可用");
assert.equal(probe.note, null, "有应用可选时不该再给提示语");
assert.equal(probe.apps[0]!.id, "VSCode.md", "默认应用排在最前");
assert.equal(probe.apps[0]!.isDefault, true);
assert.equal(probe.apps.filter((a) => a.isDefault).length, 1, "默认应用只能有一个");
assert.equal(probe.apps.every((a) => a.match === "extension"), true, "全都是按扩展名匹配到的");
assert.equal(probe.apps.every((a) => a.detail === a.id), true, "detail 给 ProgID，界面上用来区分同名应用");

// 没有扩展名 / 扩展名形状不对：都不查注册表，但要给一句人话而不是空手而归。
for (const bad of ["", "md\\..\\..\\evil", "md\"x"]) {
  const p = toWindowsProbe(bad, { entries: [], defaultId: null });
  assert.deepEqual(p.apps, [], `.${bad} 不该产出任何应用`);
  assert.ok(p.note, `.${bad} 必须给出说明`);
}
assert.ok(toWindowsProbe("md", { entries: [], defaultId: null }).note, "查不到程序时也要有说明");

// —— PowerShell 脚本的转义 ——
// 这段字符串穿过两层引号规则(JS 模板字面量 + PowerShell)，`\` 少一个就是去查了一个
// 不存在的注册表键：不报错，只是一个应用都探不到。在 macOS 上跑不了 PowerShell，
// 但「渲染出来长什么样」是能钉死的。
const ps = registryScript("md");
for (const needle of [
  "$ext = '.md'",
  "'Registry::HKEY_CLASSES_ROOT\\'",
  "'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\'",
  "'\\OpenWithProgids'",
  "'\\OpenWithList'",
  "'\\UserChoice'",
  "'\\shell\\open\\command'",
  "'Applications\\' + $v",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8", // 中文应用名不能是乱码
]) {
  assert.ok(ps.includes(needle), `PowerShell 脚本里应该出现 ${needle}`);
}
assert.ok(!ps.includes("\\\\"), "渲染出来的脚本里不该再有双反斜杠（说明转义多了一层）");
// 制表符分隔是 Node 这边解析的依据，PowerShell 里必须是反引号 t 而不是反斜杠 t。
// 输出必须走 [Console]::Out.WriteLine：直接丢进管道会被 5.1 的格式化器按控制台宽度
// 硬折行，注册表里的命令行模板轻松超过 120 字符，折了就再也拼不回去。
assert.ok(ps.includes('[Console]::Out.WriteLine("D`t$default")'), "默认 ProgID 要用 WriteLine 原样输出");
assert.ok(ps.includes('[Console]::Out.WriteLine("A`t$id`t$name`t$cmd")'), "应用行同样用 `t 分隔并原样输出");

// —— 命令行拼装 ——
const doc = "C:\\Users\\me\\My Docs\\计划 v2.md";

const vscode = buildWindowsCommand(scan.entries.find((e) => e.id === "VSCode.md")!.command, doc);
assert.deepEqual(vscode, { file: "C:\\Program Files\\Microsoft VS Code\\Code.exe", args: [doc] },
  "带空格的 exe 路径要被引号合成一个词，%1 换成文件路径");

// 注册表里的命令行是给 shell 读的,`%SystemRoot%` 这类变量到处都是;我们走 execFile
// 不过 shell,不自己展开就是「找不到程序 → 静默退回系统默认」:界面上看着接受了你选的
// 应用,打开的却是另一个。这里把两台机器上都会遇到的三种情形钉住。
process.env.SystemRoot = "C:\\WINDOWS";
const notepad = buildWindowsCommand(scan.entries.find((e) => e.id === "Applications\\notepad.exe")!.command, doc);
assert.deepEqual(notepad, { file: "C:\\WINDOWS\\system32\\NOTEPAD.EXE", args: [doc] },
  "不带引号的模板同样切得开，%SystemRoot% 要展开成真路径");
delete process.env.SystemRoot;
assert.deepEqual(
  buildWindowsCommand("%ASH_NO_SUCH_VAR%\\x.exe %1", doc),
  { file: "%ASH_NO_SUCH_VAR%\\x.exe", args: [doc] },
  "认不出来的变量原样留着（跑不起来会退回系统默认），不能展成一条错路径",
);
// 展开必须发生在替换 %1 **之前**：否则文件名里真带 %VAR% 的文档会被当成变量吃掉。
process.env.ASH_OPENER_PROBE = "被展开了";
assert.deepEqual(
  buildWindowsCommand('"C:\\a\\b.exe" "%1"', "C:\\docs\\%ASH_OPENER_PROBE%.md"),
  { file: "C:\\a\\b.exe", args: ["C:\\docs\\%ASH_OPENER_PROBE%.md"] },
  "文件路径本身不参与变量展开",
);
delete process.env.ASH_OPENER_PROBE;

const legacy = buildWindowsCommand(scan.entries.find((e) => e.id === "Legacy.md")!.command, doc);
assert.deepEqual(legacy, { file: "C:\\Tools\\viewer.exe", args: ["--view", doc] },
  "模板里没有占位符时把路径接在最后，而不是丢掉");

// 占位符的几种写法都得认；已有参数不能被挤掉。
assert.deepEqual(buildWindowsCommand('"C:\\a\\b.exe" -n %L', doc), { file: "C:\\a\\b.exe", args: ["-n", doc] });
assert.deepEqual(buildWindowsCommand('"C:\\a\\b.exe" %*', doc), { file: "C:\\a\\b.exe", args: [doc] });
assert.deepEqual(buildWindowsCommand('"C:\\a\\b.exe" /dde "%1"', doc), { file: "C:\\a\\b.exe", args: ["/dde", doc] });
// 连着两次调用必须给出同样的结果：占位符正则带 /g 时 lastIndex 会串味，这里钉住。
assert.deepEqual(buildWindowsCommand('"C:\\a\\b.exe" "%1"', doc), buildWindowsCommand('"C:\\a\\b.exe" "%1"', doc),
  "同一个模板连调两次结果必须一致");
assert.equal(buildWindowsCommand("", doc), null, "空模板不给命令，调用方退回系统默认");

// 参数是数组交给 execFile 的，不经过 shell —— 文件名里的引号和 & 不会变成命令。
const hostile = 'C:\\tmp\\a" & calc.exe & ".md';
assert.deepEqual(buildWindowsCommand('"C:\\a\\b.exe" "%1"', hostile), { file: "C:\\a\\b.exe", args: [hostile] },
  "文件名原样进 argv，不做拼接");

// 脏数据不能把「一行一个条目」的约定撕开。
const messy = parseRegistryScan(["垃圾行", "A\t\t没有 id\tcmd", "A\tOnlyId", "D\t", "A\tX\t\t"].join("\n"));
assert.deepEqual(messy, { entries: [], defaultId: null }, "缺 id、缺命令行、字段不够的行一律丢掉");

// ── 「交给系统默认」那一档：路径永远是数据，不是命令 ──────────────────────
// 这是整条打开链路上唯一非过 cmd 不可的地方（`start` 只有 cmd 里有），也因此是唯一能
// 把目录名重新解释成命令的地方。下面这些**全是合法的 Windows 目录名**，不需要调用方
// 提交任何可执行文件：`&` 没被引号包住就是命令分隔符，`%TEMP%` 会被展开成别的路径。
// 真机复现见 2026-10-20 第 2 轮审查 F1（`...\launch.exe&ver` 启动了旁边的程序并多跑了
// 一条 `ver`）。注册表模板那一档不在此列——它是 execFile 直接起 exe，中间没有 shell。
//
// 修复同日在 Windows 真机上验过，结论和踩到的坑都记在 `windowsDefaultOpenCommand` 的
// 注释里。**那一条值得单独记住**：第一版探针只看「有没有注入痕迹」，而它的对照组（旧
// 模板）也报「没注入」——因为旧模板那次其实是卡死被 kill 的，什么都没输出。探针报不出
// 阳性时，「没检测到」和「检测不出来」长得一模一样，所以自检必须先跑。
for (const dir of [
  "D:\\work\\project&ver",
  "D:\\work\\proj&md INJECTED",
  "C:\\x\\%TEMP%",
  "D:\\work\\with space (x)",
  "D:\\work\\caret^x",
  "D:\\work\\中文目录",
]) {
  const command = windowsDefaultOpenCommand(dir);
  const line = [command.file, ...command.args].join(" ");
  assert.ok(!line.includes(dir), `目录泄进了命令行：${line}`);
  for (const meta of ["&", "^", "(", ")"]) {
    assert.ok(!line.includes(meta), `元字符 ${meta} 不该出现在命令行上：${line}`);
  }
  assert.equal(command.env[WIN_OPEN_TARGET_ENV], dir, "路径原样走环境变量");
  assert.equal(command.verbatim, true, "命令行是自己写死的，别让 Node 再加一层引号");
  assert.ok(
    command.args.some((arg) => arg.includes(`"%${WIN_OPEN_TARGET_ENV}%"`)),
    "占位必须被双引号包住——展开出来的 & 才会留在参数里而不是变成命令分隔符",
  );
  assert.ok(command.args.includes("/d"), "/d 跳过注册表里挂的 AutoRun 脚本");
}
assert.deepEqual(
  windowsDefaultOpenCommand("C:\\a").args.filter((arg) => arg.startsWith("start")),
  ['start "" "%ASH_OPEN_TARGET%"'],
  "start 的第一个引号对是窗口标题，省掉它的话带空格的路径会被当成标题",
);

console.log("✓ openers/windows：注册表输出解析、默认应用、%1 替换、老式条目兜底，以及默认打开不把路径拼进命令行");
