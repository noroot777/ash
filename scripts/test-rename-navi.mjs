// 改名脚本手写修复层的落点契约：整份新建的文件按磁盘实况认，不按 git 清单 —— 没加进 git 的同名文件
// 不许被覆盖（整次拒绝、一个文件都不动）；已经生成好、还没加进 git 的那份，重跑和核对都当它在。
// 文件清单的契约：没加进 git 的新文件（在途分支刚写的）也要过一遍 —— 不加 --dirty 拒绝，核对报出来，--dirty 照改。
// 正文：含 NUL 的、不是 UTF-8 的认不准，整次拒绝、字节不动、核对与清单都点名；登记过的二进制不看；Windows 验证记录整份不改。
// 磁盘上的形态：路径上每一级都不透过符号链接读写建（链到仓库外的东西不许被改、不许被建出目录）；还没提交的删除、
// 要挪名的链接、所在目录或落点上级是链接的，动手之前整次拒绝；规划之后才被别的进程换掉、改掉的，动手时停下。
// 索引：挪名时按路径精确认索引项（特殊字符的文件名不配上别人的项），带标志的、有冲突的（路径里带 TAB 也认得）动手之前整次拒绝。
// 写正文：短写接着写到满；写到一半失败（磁盘满）原文件原样、不留临时文件；权限位照旧；写临时文件期间落点被
// 保存、被原子保存换了 inode、所在目录被换成链接，换上之前拦下；读原文期间目录换成链接，临时文件都不建；长文件名放得下；
// 换上之后清临时文件出错也记进清单，目录换成了链接就不透过它删。
// 跑在临时仓库里：拷一份脚本，配一份只有两项的修复层。
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("./rename-navi.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
// 外面带进来的 GIT_DIR 之类会让临时仓库里的 git 改到别的仓库头上。
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const root = mkdtempSync(join(tmpdir(), "navi-rename-script-"));
// 仓库外的一份原文件（目录名里碰巧带出 ash 的话换一个，免得链接本身被当成「写着旧名」）。
let outside;
do {
  if (outside) rmSync(outside, { recursive: true, force: true });
  outside = mkdtempSync(join(tmpdir(), "navi-rename-outside-"));
} while (/ash/i.test(outside));
const gitOut = (args, input) => {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, env, encoding: "utf8", input });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const git = (...args) => { gitOut(args); };
const run = (...args) => spawnSync(process.execPath, ["scripts/rename-navi.mjs", ...args], { cwd: root, env, encoding: "utf8" });
const read = (path) => readFileSync(join(root, path), "utf8");
const write = (path, text) => writeFileSync(join(root, path), text);

const CREATED = "notes/created.txt";
const CONTENT = "MARKER-CREATED\nbody\n";
try {
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "notes"));
  copyFileSync(SCRIPT, join(root, "scripts", "rename-navi.mjs"));
  for (const name of ["rename-navi-report.mjs", "rename-navi-fs.mjs"]) copyFileSync(join(REPO, "scripts", name), join(root, "scripts", name));
  write("scripts/rename-navi-fixes.mjs", `export const FIXES = ${JSON.stringify([
    { file: CREATED, why: "整份新建", marker: "MARKER-CREATED", content: CONTENT },
    { file: "notes/patched.txt", why: "按段替换", marker: "PATCHED", hunks: [{ from: "before\n", to: "PATCHED\n" }] },
  ])};\n`);
  write("notes/patched.txt", "before\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  // 落点有一份没加进 git 的别的内容：拒绝，它和别的文件都原样。
  write(CREATED, "someone else's work\n");
  for (const args of [[], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 5, `${args.join(" ") || "改名"}：落点被占应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /notes\/created\.txt.*不覆盖/);
  }
  assert.equal(read(CREATED), "someone else's work\n", "没加进 git 的文件不许被覆盖");
  assert.equal(read("notes/patched.txt"), "before\n", "拒绝时一个文件都不动");

  // 落点空着：建出来，另一项照常补上。
  rmSync(join(root, CREATED));
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(read(CREATED), CONTENT);
  assert.equal(read("notes/patched.txt"), "PATCHED\n");

  // 刚生成、还没加进 git：核对认它在，重跑什么都不改。
  const check = run("--check");
  assert.equal(check.status, 0, `生成完立刻核对应为 0\n${check.stdout}${check.stderr}`);
  const again = run("--dirty");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /挪了 0 个文件，改了 0 个文件/, "重跑应是空操作");
  assert.equal(read(CREATED), CONTENT);

  // 加进 git 之后同样是空操作；被人改得没了记号，按「已有一份别的内容」拒绝。
  git("add", "-A");
  assert.equal(run("--check").status, 0);
  write(CREATED, "edited away\n");
  assert.equal(run("--check").status, 5);
  assert.ok(existsSync(join(root, CREATED)));
  console.log("✓ 改名脚本：新建落点按磁盘认，占用就拒绝不覆盖；已生成未加进 git 的重跑与核对都是空操作");

  // 在途分支刚写、还没加进 git 的新文件：只看索引会把它漏掉，改名、核对都报「没有要改的」。
  write(CREATED, CONTENT);
  git("add", "-A");
  git("commit", "-q", "-m", "created");
  const WIDGET = "notes/ash-widget.ts";
  write(WIDGET, "export const ashWidget = 1;\n");
  const refused = run();
  assert.equal(refused.status, 2, `有没加进 git 的文件、没加 --dirty 应拒绝\n${refused.stdout}${refused.stderr}`);
  assert.equal(read(WIDGET), "export const ashWidget = 1;\n", "拒绝时不动它");
  const pending = run("--check");
  assert.equal(pending.status, 1, `核对要看见没加进 git 的文件\n${pending.stdout}${pending.stderr}`);
  assert.match(pending.stdout, /^move notes\/ash-widget\.ts → notes\/navi-widget\.ts$/m);
  const dirty = run("--dirty");
  assert.equal(dirty.status, 0, dirty.stderr);
  assert.ok(!existsSync(join(root, WIDGET)), "旧名文件应已挪走");
  assert.equal(read("notes/navi-widget.ts"), "export const naviWidget = 1;\n");
  assert.equal(run("--check").status, 0, "改完核对应为 0");
  console.log("✓ 改名脚本：没加进 git 的新文件也改名、也核对；不加 --dirty 拒绝");

  // 正文认不认得：只有不含 NUL、按 UTF-8 往返逐字节一样的才改。含 NUL 的（handoff-capability.ts 拿 NUL 当拼键分隔符，
  // 曾被当成二进制整份跳过、核对和清单都不报）、往返对不上的，一律整次拒绝、一个字节不动、清单里点名 —— 不按
  // 「字节里看不看得见 ash」放行：没登记扩展名的 wasm 能往返 UTF-8，换了名长度字段就坏了；UTF-16 里 ash 的字节不连着；
  // Latin-1 不写 ash 也认不准。登记过的二进制不看正文。Windows 真机验证记录写的是改名前的事实，整份不进改名。
  mkdirSync(join(root, "docs"));
  const bytes = (path) => readFileSync(join(root, path));
  const WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 4, 3, 97, 115, 104]); // 一个名叫 ash 的自定义段
  const unsure = {
    "notes/nul.ts": [Buffer.from('import { x } from "@ash/shared";\nconst ashKey = `${a}\0${b}`;\n', "utf8"), /含 NUL 字节/],
    "notes/module": [WASM, /含 NUL 字节/],
    "notes/utf16-bom.txt": [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('import { x } from "@ash/shared";\n', "utf16le")]), /不是合法的 UTF-8/],
    "notes/utf16.txt": [Buffer.from('import { x } from "@ash/shared";\n', "utf16le"), /含 NUL 字节/],
    "notes/latin1.txt": [Buffer.from("caf\xe9 ash\n", "latin1"), /不是合法的 UTF-8/],
    "notes/latin1-plain.txt": [Buffer.from("caf\xe9 au lait\n", "latin1"), /不是合法的 UTF-8/],
  };
  for (const [path, [content]] of Object.entries(unsure)) writeFileSync(join(root, path), content);
  writeFileSync(join(root, "notes/module.wasm"), WASM);
  const WINDOWS = "docs/rename-navi-windows.md";
  const WINDOWS_TEXT = "# Windows 真机验证\n\n- 旧服务读 ASH_DB，任务分支 ash/abc，锁 ash.db.ash.lock\n- 那台的 ash 服务跑在 :4317\n";
  write(WINDOWS, WINDOWS_TEXT);
  git("add", "-A");
  git("commit", "-q", "-m", "content kinds");
  const reEscape = (path) => path.replace(/[.]/g, "\\.");
  for (const args of [[], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ") || "改名"}：认不准的正文应整次拒绝\n${r.stdout}${r.stderr}`);
    for (const [path, [, why]] of Object.entries(unsure)) assert.match(r.stderr, new RegExp(`${reEscape(path)}：${why.source}`), `${path} 要点名`);
    assert.doesNotMatch(r.stderr, /module\.wasm/, "登记过的二进制不拦");
  }
  for (const [path, [content]] of Object.entries(unsure)) assert.deepEqual(bytes(path), content, `${path}：拒绝时一个字节不动`);
  const kinds = run("--report");
  assert.equal(kinds.status, 0, kinds.stderr);
  assert.match(kinds.stdout, /^## not-text（7 份）$/m);
  for (const [path, [, why]] of Object.entries(unsure)) assert.match(kinds.stdout, new RegExp(`^- ${reEscape(path)}：${why.source}`, "m"), `${path} 在清单里点名`);
  assert.match(kinds.stdout, /^- notes\/module\.wasm：登记过的二进制格式/m, "登记过的二进制字节里有 ash 也点名");
  assert.doesNotMatch(kinds.stdout, /^- docs\/rename-navi-windows\.md:/m, "Windows 记录不逐处列成「留下的兼容值」");
  assert.match(kinds.stdout, /^- docs\/rename-navi-windows\.md：\d+ 行$/m, "Windows 记录记在改名自己的文档里");
  // 照提示处理之后照常改名：源码里的 NUL 写成转义，其余认不准的挪走；登记过的二进制、Windows 记录原样。
  write("notes/nul.ts", 'import { x } from "@ash/shared";\nconst ashKey = `${a}\\u0000${b}`;\n');
  git("rm", "-q", ...Object.keys(unsure).filter((path) => path !== "notes/nul.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "resolved");
  const pendingNul = run("--check");
  assert.equal(pendingNul.status, 1, `${pendingNul.stdout}${pendingNul.stderr}`);
  assert.match(pendingNul.stdout, /^edit notes\/nul\.ts$/m);
  assert.doesNotMatch(pendingNul.stdout, /rename-navi-windows|module\.wasm/, "Windows 记录、登记过的二进制不算要改的");
  const resolved = run();
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(read("notes/nul.ts"), 'import { x } from "@navi/shared";\nconst naviKey = `${a}\\u0000${b}`;\n');
  assert.deepEqual(bytes("notes/module.wasm"), WASM, "登记过的二进制一个字节不动");
  assert.equal(read(WINDOWS), WINDOWS_TEXT, "Windows 记录一个字不改");
  git("add", "-A");
  git("commit", "-q", "-m", "renamed");
  assert.equal(run("--check").status, 0, "改完核对应为 0");
  git("rm", "-r", "-q", "docs", "notes/nul.ts", "notes/module.wasm");
  git("commit", "-q", "-m", "drop content kinds");
  console.log("✓ 改名脚本：含 NUL、不是 UTF-8 的正文（wasm、UTF-16、Latin-1，写没写 ash 都算）整次拒绝、字节不动、核对与清单点名；登记过的二进制不看；Windows 验证记录整份不改");

  // 链到仓库外的文本文件：不透过链接改它，核对也不因为它报要改。
  const OUTSIDE_TEXT = 'const ashWidget = "ash";\n';
  writeFileSync(join(outside, "outside.txt"), OUTSIDE_TEXT);
  symlinkSync(join(outside, "outside.txt"), join(root, "notes/widget.txt"));
  git("add", "-A");
  git("commit", "-q", "-m", "links");
  const linked = run();
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(readFileSync(join(outside, "outside.txt"), "utf8"), OUTSIDE_TEXT, "链接指着的仓库外文件不许被改");
  assert.equal(run("--check").status, 0);
  // 要挪名的链接：脚本不替你挪，改名和核对都整次拒绝。
  symlinkSync(join(outside, "outside.txt"), join(root, "notes/ash-link.txt"));
  git("add", "-A");
  git("commit", "-q", "-m", "named link");
  for (const args of [[], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ") || "改名"}：要挪名的符号链接应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /notes\/ash-link\.txt：符号链接/);
  }
  assert.equal(readFileSync(join(outside, "outside.txt"), "utf8"), OUTSIDE_TEXT);
  git("rm", "-q", "notes/ash-link.txt");
  git("commit", "-q", "-m", "drop link");

  // 还没提交的删除：旧名文件在索引里、工作区里删掉了。动手之前整次拒绝，别挪到一半才发现源文件不在。
  write("notes/ash-a.ts", "export const ashWidget = 1;\n");
  write("notes/ash-z.ts", "export const ashWidget = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "two");
  rmSync(join(root, "notes/ash-z.ts"));
  for (const args of [["--dirty"], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}：没提交的删除应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /notes\/ash-z\.ts：在工作区里删掉了/);
  }
  assert.deepEqual(readdirSync(join(root, "notes")).filter((name) => /-a\.ts$/.test(name)), ["ash-a.ts"], "拒绝时一个文件都不挪");
  assert.equal(read("notes/ash-a.ts"), "export const ashWidget = 1;\n");
  // 删除提交（git rm）之后照常改。
  git("rm", "-q", "--cached", "notes/ash-z.ts");
  const afterRm = run("--dirty");
  assert.equal(afterRm.status, 0, afterRm.stderr);
  assert.equal(read("notes/navi-a.ts"), "export const naviWidget = 1;\n");
  // 已跟踪文件是自己改名、再把索引项挪过去的：索引里是新名，暂存的还是原来那份内容（同 git mv）。
  const indexed = spawnSync("git", ["ls-files", "-s", "--", "notes/ash-a.ts", "notes/navi-a.ts"], { cwd: root, env, encoding: "utf8" }).stdout;
  assert.match(indexed, /\tnotes\/navi-a\.ts$/m);
  assert.doesNotMatch(indexed, /notes\/ash-a\.ts/);
  const staged = spawnSync("git", ["show", ":notes/navi-a.ts"], { cwd: root, env, encoding: "utf8" }).stdout;
  assert.equal(staged, "export const ashWidget = 1;\n", "暂存区里还是原来那份内容");

  // 所在目录换成了指到仓库外的链接（索引里还是原来的文件）：不读它、不在外面建目录，整次拒绝。
  git("add", "-A");
  git("commit", "-q", "-m", "renamed");
  mkdirSync(join(root, "tree/ash-dir"), { recursive: true });
  write("tree/ash-dir/widget.ts", "export const ashWidget = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "tree");
  rmSync(join(root, "tree"), { recursive: true });
  mkdirSync(join(outside, "tree/ash-dir"), { recursive: true });
  writeFileSync(join(outside, "tree/ash-dir/widget.ts"), "export const ashWidget = 1;\n");
  symlinkSync(join(outside, "tree"), join(root, "tree"));
  for (const args of [["--dirty"], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}：所在目录是链接应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /tree\/ash-dir\/widget\.ts：所在目录 tree 是符号链接/);
  }
  assert.deepEqual(readdirSync(join(outside, "tree")), ["ash-dir"], "仓库外不许多出目录");
  assert.equal(readFileSync(join(outside, "tree/ash-dir/widget.ts"), "utf8"), "export const ashWidget = 1;\n");
  rmSync(join(root, "tree"));
  git("rm", "-r", "-q", "--cached", "tree");
  git("commit", "-q", "-m", "drop tree");

  // 挪名的落点在链接下面：ash-dir 要挪成 navi-dir，而 navi-dir 是一个指到仓库外的链接。
  mkdirSync(join(root, "pair/ash-dir"), { recursive: true });
  write("pair/ash-dir/w.ts", "export const ashWidget = 1;\n");
  mkdirSync(join(outside, "target"));
  symlinkSync(join(outside, "target"), join(root, "pair/navi-dir"));
  git("add", "-A");
  git("commit", "-q", "-m", "pair");
  for (const args of [[], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ") || "改名"}：落点上级是链接应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /pair\/ash-dir\/w\.ts → pair\/navi-dir\/w\.ts：落点所在目录 pair\/navi-dir 是符号链接/);
  }
  assert.deepEqual(readdirSync(join(outside, "target")), [], "链接指着的目录里不许多出东西");
  assert.ok(existsSync(join(root, "pair/ash-dir/w.ts")), "拒绝时不挪");
  git("rm", "-r", "-q", "pair");
  git("commit", "-q", "-m", "drop pair");
  console.log("✓ 改名脚本：路径上每一级都不透过符号链接读写建；没提交的删除、链接与链接下的文件/落点动手之前整次拒绝");

  // 索引项按路径精确认：ash[1].txt、ash?.txt 当路径参数是通配模式，会配上 ash1.txt（ash1 不是 ash 这个词，不改名）那一项。
  // 暂存的和工作区里的不一样：挪完每个新名暂存的都得是它自己原来那份，ash1.txt 原样。（? 和 TAB 在 Windows 上不能进文件名。）
  const special = [
    ["idx/ash1.txt", "idx/ash1.txt"],
    ["idx/ash[1].txt", "idx/navi[1].txt"],
    ...(process.platform === "win32" ? [] : [["idx/ash?.txt", "idx/navi?.txt"], ["idx/ash\tt.txt", "idx/navi\tt.txt"]]),
  ];
  mkdirSync(join(root, "idx"));
  special.forEach(([path], i) => write(path, `staged ${i}\n`));
  git("add", "-A");
  git("commit", "-q", "-m", "special names");
  special.forEach(([path], i) => write(path, `working ${i}\n`));
  const specialRun = run("--dirty");
  assert.equal(specialRun.status, 0, specialRun.stderr);
  special.forEach(([, renamed], i) => {
    assert.equal(gitOut(["show", `:${renamed}`]), `staged ${i}\n`, `${JSON.stringify(renamed)} 暂存的要是它自己原来那份`);
    assert.equal(read(renamed), `working ${i}\n`);
  });
  assert.deepEqual(gitOut(["ls-files", "-z", "idx"]).split("\0").filter(Boolean).sort(), special.map(([, renamed]) => renamed).sort(), "索引里只剩新名");
  git("add", "-A");
  git("commit", "-q", "-m", "special renamed");

  // 带标志的索引项：intent-to-add 挪过去会变成暂存了一份空文件，assume-unchanged / skip-worktree 会丢，后两种改了正文
  // git 还看不见。要挪的、只改正文的，动手之前整次拒绝。
  mkdirSync(join(root, "flag"));
  for (const name of ["ash-au.txt", "ash-sw.txt", "sw-edit.ts"]) write(`flag/${name}`, "export const ashWidget = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "flags");
  write("flag/ash-ita.txt", "intent\n");
  git("add", "-N", "flag/ash-ita.txt");
  git("update-index", "--assume-unchanged", "flag/ash-au.txt");
  git("update-index", "--skip-worktree", "flag/ash-sw.txt", "flag/sw-edit.ts");
  for (const args of [["--dirty"], ["--check"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}：带标志的索引项应整次拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /flag\/ash-au\.txt：索引里标着 assume-unchanged/);
    assert.match(r.stderr, /flag\/ash-sw\.txt：索引里标着 skip-worktree/);
    assert.match(r.stderr, /flag\/sw-edit\.ts：索引里标着 skip-worktree/);
    assert.match(r.stderr, /flag\/ash-ita\.txt：索引里标着 intent-to-add/);
  }
  assert.deepEqual(readdirSync(join(root, "flag")).sort(), ["ash-au.txt", "ash-ita.txt", "ash-sw.txt", "sw-edit.ts"], "拒绝时一个文件都不挪");
  assert.equal(read("flag/sw-edit.ts"), "export const ashWidget = 1;\n");
  git("update-index", "--no-assume-unchanged", "flag/ash-au.txt");
  git("update-index", "--no-skip-worktree", "flag/ash-sw.txt", "flag/sw-edit.ts");
  git("rm", "-r", "-q", "-f", "flag");
  git("commit", "-q", "-m", "drop flags");

  // 只有一个非 0 stage 的冲突项、路径里带 TAB：按第一个 TAB 切出完整路径，在规划时认出冲突；排在前面的文件也不许先挪。
  if (process.platform !== "win32") {
    mkdirSync(join(root, "conf"));
    write("conf/a-ash.txt", "first\n");
    write("conf/ash\tc.txt", "conflicted\n");
    git("add", "conf/a-ash.txt");
    const blob = gitOut(["hash-object", "-w", "conf/ash\tc.txt"]).trim();
    gitOut(["update-index", "-z", "--index-info"], `100644 ${blob} 1\tconf/ash\tc.txt\0`);
    const r = run("--dirty");
    assert.equal(r.status, 2, `带 TAB 的冲突项应在规划时拒绝\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /conf\/ash\tc\.txt：有没解决的冲突/);
    assert.deepEqual(readdirSync(join(root, "conf")).sort(), ["a-ash.txt", "ash\tc.txt"], "拒绝时排在前面的也不挪");
    git("update-index", "--force-remove", "conf/ash\tc.txt");
    git("rm", "-r", "-q", "-f", "--cached", "conf");
    rmSync(join(root, "conf"), { recursive: true });
  }
  console.log("✓ 改名脚本：索引项按路径精确认、暂存内容各归各的；带标志的、有冲突的（路径带 TAB）动手之前整次拒绝");

  // 规划之后工作区被别的进程动了：第一个文件挪完时动手（前面一串挪名给出足够的空档），脚本要停下，不拿规划时的结论
  // 去挪、去盖。一次把源目录换成指到仓库外的链接，一次改掉一个只等着换正文的文件。
  const BULK = 80;
  for (let i = 0; i < BULK; i++) write(`a-ash-${String(i).padStart(3, "0")}.ts`, "export const ashValue = 1;\n");
  mkdirSync(join(root, "z-ash"));
  write("z-ash/widget.ts", "export const ashWidget = 1;\n");
  write("zz.ts", "export const ashWidget = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "bulk");
  const midRun = async (meddle) => {
    let meddled = false;
    const watcher = watch(root, () => {
      if (meddled || !existsSync(join(root, "a-navi-000.ts"))) return;
      meddled = true;
      watcher.close();
      meddle();
    });
    const child = spawn(process.execPath, ["scripts/rename-navi.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    watcher.close();
    assert.ok(meddled, "另一个进程应在改名途中动手（没赶上就是空档太短）");
    return { status, stderr };
  };
  const restore = () => {
    git("reset", "-q", "--hard");
    git("clean", "-qfd");
  };
  mkdirSync(join(outside, "swap"));
  writeFileSync(join(outside, "swap/widget.ts"), "EXTERNAL ORIGINAL\n");
  const swapped = await midRun(() => {
    renameSync(join(root, "z-ash"), join(outside, "saved-z"));
    symlinkSync(join(outside, "swap"), join(root, "z-ash"));
  });
  assert.equal(swapped.status, 3, `源目录途中换成链接应停下\n${swapped.stderr}`);
  assert.match(swapped.stderr, /z-ash\/widget\.ts：规划之后所在目录 z-ash 是符号链接/);
  assert.equal(readFileSync(join(outside, "swap/widget.ts"), "utf8"), "EXTERNAL ORIGINAL\n", "仓库外的原文件不许被挪走、被盖");
  rmSync(join(root, "z-ash"));
  renameSync(join(outside, "saved-z"), join(root, "z-ash"));
  restore();
  const SOMEONE = "export const ashWidget = 2; // 别的进程刚改的\n";
  const edited = await midRun(() => writeFileSync(join(root, "zz.ts"), SOMEONE));
  assert.equal(edited.status, 3, `正文途中被改应停下\n${edited.stderr}`);
  assert.match(edited.stderr, /zz\.ts：规划之后内容被改过/);
  assert.equal(read("zz.ts"), SOMEONE, "别人刚写的内容不许被规划时的结果盖掉");
  restore();
  console.log("✓ 改名脚本：规划之后源目录被换成链接、正文被改，动手时停下，不挪不盖");

  // 写正文的协议：在系统写入这一层注入短写和磁盘满，用临时仓库里那份边界模块（它的仓库根就是这里）。
  const boundary = await import(pathToFileURL(join(root, "scripts", "rename-navi-fs.mjs")).href);
  const realWrite = fs.writeSync;
  const realUnlink = fs.unlinkSync;
  const injectWrite = (fake) => { fs.writeSync = fake; syncBuiltinESMExports(); };
  // 第一次往临时文件里写的时候，让「别的程序」动一下手，再照常写。
  const duringWrite = (meddle) => {
    let once = false;
    injectWrite((...args) => {
      if (!once) { once = true; meddle(); }
      return realWrite(...args);
    });
  };
  const ORIGINAL = "uncommitted Ash source content\n";
  const NEXT = "uncommitted Navi source content\n";
  try {
    write("io.txt", ORIGINAL);
    chmodSync(join(root, "io.txt"), 0o755);
    injectWrite((fd, buf, offset, length, position) => realWrite(fd, buf, offset, Math.min(length, 3), position));
    boundary.writeInRepo("io.txt", NEXT, false, [], { original: ORIGINAL, id: boundary.identity("io.txt") });
    assert.equal(read("io.txt"), NEXT, "短写要接着写到满，不能写一截就当写完");
    assert.equal(statSync(join(root, "io.txt")).mode & 0o777, 0o755, "权限位照抄原文件");
    write("io.txt", ORIGINAL);
    injectWrite(() => { throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" }); });
    assert.throws(() => boundary.writeInRepo("io.txt", NEXT, false, [], { original: ORIGINAL, id: boundary.identity("io.txt") }), /No space left/);
    assert.equal(read("io.txt"), ORIGINAL, "写到一半失败，原文件一个字节都不许少");
    assert.throws(() => boundary.writeInRepo("io-new.txt", NEXT, true, []), /No space left/);
    assert.ok(!existsSync(join(root, "io-new.txt")), "新建写失败不留半个文件");
    assert.deepEqual(readdirSync(root).filter((name) => name.includes(".navi-rename-")), [], "临时文件要收掉");

    const SAVED = "export const saved = 'someone else just saved this';\n";
    write("io.txt", ORIGINAL);
    let expect = { original: ORIGINAL, id: boundary.identity("io.txt") };
    duringWrite(() => writeFileSync(join(root, "io.txt"), SAVED));
    assert.throws(() => boundary.writeInRepo("io.txt", NEXT, false, [], expect), /规划之后被换成了别的文件或内容被改过/);
    assert.equal(read("io.txt"), SAVED, "写临时文件期间别人保存的内容不许被盖");
    write("io.txt", ORIGINAL);
    expect = { original: ORIGINAL, id: boundary.identity("io.txt") };
    duringWrite(() => { writeFileSync(join(root, "io.saved"), SAVED); renameSync(join(root, "io.saved"), join(root, "io.txt")); });
    assert.throws(() => boundary.writeInRepo("io.txt", NEXT, false, [], expect), /规划之后被换成了别的文件或内容被改过/);
    assert.equal(read("io.txt"), SAVED, "原子保存换了 inode 的新内容不许被盖");
    mkdirSync(join(root, "iodir"));
    write("iodir/f.txt", ORIGINAL);
    expect = { original: ORIGINAL, id: boundary.identity("iodir/f.txt") };
    duringWrite(() => { renameSync(join(root, "iodir"), join(outside, "iodir")); symlinkSync(join(outside, "iodir"), join(root, "iodir")); });
    const swappedDone = [];
    assert.throws(() => boundary.writeInRepo("iodir/f.txt", NEXT, false, swappedDone, expect), /iodir 是符号链接/);
    assert.equal(readFileSync(join(outside, "iodir/f.txt"), "utf8"), ORIGINAL, "目录途中换成链接，仓库外的原文件不许被替换");
    // 临时文件是跟着目录一起被挪出去的：不透过链接去删它，记进清单让人手工删。
    const strayTemps = readdirSync(join(outside, "iodir")).filter((name) => name.includes(".navi-rename-"));
    assert.equal(strayTemps.length, 1);
    assert.match(swappedDone.at(-1) ?? "", /^留下了临时文件 iodir\/\.navi-rename-.*手工删掉$/);
    injectWrite(realWrite);
    rmSync(join(root, "iodir"));
    rmSync(join(outside, "iodir"), { recursive: true });

    // 读原文的时候（开着旧句柄）落点被原子保存、所在目录被换成链接：旧句柄核过不算数，换上之前按当前路径再核。
    const realRead = fs.readFileSync;
    const duringRead = (meddle) => {
      let once = false;
      fs.readFileSync = (...args) => {
        if (!once && typeof args[0] === "number") { once = true; meddle(); }
        return realRead(...args);
      };
      syncBuiltinESMExports();
    };
    const realOpen = fs.openSync;
    const tempOpens = [];
    try {
      fs.openSync = (path, ...rest) => {
        if (String(path).includes(".navi-rename-")) tempOpens.push(String(path));
        return realOpen(path, ...rest);
      };
      syncBuiltinESMExports();
      write("io.txt", ORIGINAL);
      expect = { original: ORIGINAL, id: boundary.identity("io.txt") };
      duringRead(() => { writeFileSync(join(root, "io.saved"), SAVED); renameSync(join(root, "io.saved"), join(root, "io.txt")); });
      // 旧那份被换下去时 nlink 变了、ctime 跟着变：读完那一刻就认得出，最晚也在换上之前按当前路径认出。
      assert.throws(() => boundary.writeInRepo("io.txt", NEXT, false, [], expect), /读原文的时候内容被改了|规划之后被换成了别的文件或内容被改过/);
      assert.equal(read("io.txt"), SAVED, "读原文期间原子保存的新内容不许被盖");
      mkdirSync(join(root, "rdir"));
      write("rdir/f.txt", ORIGINAL);
      expect = { original: ORIGINAL, id: boundary.identity("rdir/f.txt") };
      duringRead(() => { renameSync(join(root, "rdir"), join(outside, "rdir")); symlinkSync(join(outside, "rdir"), join(root, "rdir")); });
      assert.throws(() => boundary.writeInRepo("rdir/f.txt", NEXT, false, [], expect), /rdir 是符号链接/);
      assert.equal(readFileSync(join(outside, "rdir/f.txt"), "utf8"), ORIGINAL, "读原文期间目录换成链接，仓库外的原文件不许被替换");
      // 建临时文件也是按路径动手：读完原文、建之前按当前路径再核，链接那头连临时文件都不许建出来。
      assert.ok(!tempOpens.some((path) => path.includes("rdir")), `读原文期间目录换成链接，不许在链接那头建临时文件：${tempOpens.join(", ")}`);
      assert.deepEqual(readdirSync(join(outside, "rdir")), ["f.txt"]);
      rmSync(join(root, "rdir"));
    } finally {
      fs.readFileSync = realRead;
      fs.openSync = realOpen;
      syncBuiltinESMExports();
    }

    // 新建换上（link）之后、清临时文件之前目录被换成链接，链接那头恰好有一个同名文件：不透过链接删，那份不许少。
    const realLink = fs.linkSync;
    try {
      mkdirSync(join(root, "ldir"));
      mkdirSync(join(outside, "ldir-other"));
      fs.linkSync = (temp, target) => {
        realLink(temp, target);
        writeFileSync(join(outside, "ldir-other", String(temp).split(/[\\/]/).pop()), "VICTIM\n");
        renameSync(join(root, "ldir"), join(outside, "ldir-moved"));
        symlinkSync(join(outside, "ldir-other"), join(root, "ldir"));
      };
      syncBuiltinESMExports();
      const linkDone = [];
      assert.throws(() => boundary.writeInRepo("ldir/new.txt", NEXT, true, linkDone), /ldir 是符号链接/);
      assert.equal(linkDone[0], "建了 ldir/new.txt", "已经换上的新建要先记进清单");
      assert.match(linkDone[1] ?? "", /^留下了临时文件 ldir\/\.navi-rename-.*手工删掉$/);
      const victims = readdirSync(join(outside, "ldir-other")).filter((name) => name.includes(".navi-rename-"));
      assert.equal(victims.length, 1);
      assert.equal(readFileSync(join(outside, "ldir-other", victims[0]), "utf8"), "VICTIM\n", "链接那头的同名文件不许被删");
    } finally {
      fs.linkSync = realLink;
      syncBuiltinESMExports();
    }
    rmSync(join(root, "ldir"));
    for (const name of ["ldir-other", "ldir-moved"]) rmSync(join(outside, name), { recursive: true, force: true });

    // 挪名：建落点目录的时候源目录被换成指到仓库外的链接，挪之前拦下，外面的文件不许被搬进来。
    const realMkdir = fs.mkdirSync;
    try {
      mkdirSync(join(root, "msrc"));
      write("msrc/memo.txt", "EXTERNAL_UNRELATED_CONTENT\n");
      const id = boundary.identity("msrc/memo.txt");
      let once = false;
      fs.mkdirSync = (...args) => {
        if (!once) { once = true; renameSync(join(root, "msrc"), join(outside, "msrc")); symlinkSync(join(outside, "msrc"), join(root, "msrc")); }
        return realMkdir(...args);
      };
      syncBuiltinESMExports();
      assert.throws(() => boundary.moveInRepo("msrc/memo.txt", "mdst/memo.txt", id, []), /msrc 是符号链接/);
      assert.equal(readFileSync(join(outside, "msrc/memo.txt"), "utf8"), "EXTERNAL_UNRELATED_CONTENT\n", "外面的文件不许被搬进仓库");
      assert.ok(!existsSync(join(root, "mdst/memo.txt")));
    } finally {
      fs.mkdirSync = realMkdir;
      syncBuiltinESMExports();
    }
    rmSync(join(root, "msrc"));
    rmSync(join(root, "mdst"), { recursive: true, force: true });

    // 接近文件名长度上限的文件：临时名不抄原文件名，照样能改。
    const LONG = `${"l".repeat(240)}.txt`;
    write(LONG, ORIGINAL);
    boundary.writeInRepo(LONG, NEXT, false, [], { original: ORIGINAL, id: boundary.identity(LONG) });
    assert.equal(read(LONG), NEXT);
    rmSync(join(root, LONG));

    // 换上之后清临时文件出错：这次新建已经在清单里，留下的临时文件也说清在哪。
    fs.unlinkSync = (path) => {
      if (String(path).includes(".navi-rename-")) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      return realUnlink(path);
    };
    syncBuiltinESMExports();
    const done = [];
    assert.throws(() => boundary.writeInRepo("io-made.txt", NEXT, true, done), /I\/O error/);
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
    assert.equal(read("io-made.txt"), NEXT);
    assert.equal(done[0], "建了 io-made.txt", "已经换上的改动要先记进清单");
    assert.match(done[1] ?? "", /^留下了临时文件 \.navi-rename-.*手工删掉$/);
    for (const name of readdirSync(root).filter((entry) => entry.includes(".navi-rename-") || entry === "io-made.txt")) rmSync(join(root, name));
  } finally {
    injectWrite(realWrite);
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
  }
  rmSync(join(root, "io.txt"));
  console.log("✓ 改名脚本：写正文短写写满、磁盘满时原文原样不留临时文件、权限位照旧；换上之前再核（写临时文件、读原文期间的保存与换目录都拦下）、建临时文件之前再核目录、挪名在建落点目录之后再核源；长文件名放得下；清临时文件出错也记账、不透过链接删");

  // 本仓库的剩余清单：旧名登记处逐行列着，更早一代 harness 单列且每一处都有理由（只读，不改仓库）。
  const listed = spawnSync(process.execPath, [SCRIPT, "--report"], { cwd: REPO, env, encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^## legacy-registry（\d+ 处）/m, "旧名登记处要逐行列出来");
  assert.match(listed.stdout, /^- shared\/src\/legacy-names\.ts:\d+/m);
  assert.match(listed.stdout, /^# 二、更早一代 harness（\d+ 处）/m, "harness 那一代单列");
  assert.doesNotMatch(listed.stdout, /^## unclassified/m, "每一处 harness 都要有理由：认不出的要么补规则，要么是漏改");
  assert.doesNotMatch(listed.stdout, /rename-navi-remaining\.md：/, "清单不记它自己：生成时它是空的，记进去就和重新生成的对不上");
  assert.match(listed.stdout, /^- docs\/rename-navi-windows\.md：\d+ 行$/m, "Windows 真机验证记录整份不进改名");
  console.log("✓ 剩余清单：旧名登记处逐行列出，harness 单列且没有说不出理由的");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
