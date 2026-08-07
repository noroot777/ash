// 前端约定的 grep 闸，挂在 web-next build 前置（`npm -w web-next run build`）。
// 挂这里而不是 pre-commit：这两条要在「前端代码上线前」拦住，而 server 从磁盘读 web-next/dist，
// 不 build 就不生效——build 是前端改动上线的唯一通道，等价于每次前端上线都跑一遍。
// （根文件体积闸走的是另一个通道 .githooks/pre-commit：两条规则的触发时机不同，不捆一起。）
import { readdirSync, statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web-next/src");

// 原生 title 的存量。CLAUDE.md 的约定是「改到它时顺手迁移，不必专门做一轮」，
// 所以这条是棘轮：存量不拦、新增才拦。顺手迁移几个之后把这个数字调低即可。
const NATIVE_TITLE_BASELINE = 53;

// 行尾写 `// allow-native` 可豁免该行（误报时用，别拿来绕规则）。
const EXEMPT = /\/\/\s*allow-native/;

// 把注释内容抹成等长空格再扫，否则「替代浏览器原生 alert(报错)」这种说明文字会被当成违规。
// 抹成空格而不是删掉，是为了行号和列偏移都还对得上。
function stripComments(src) {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return blanked
    .split("\n")
    .map((line) => {
      const i = line.replace(/:\/\//g, ":xx").indexOf("//");
      return i < 0 ? line : line.slice(0, i) + " ".repeat(line.length - i);
    })
    .join("\n");
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const dialogHits = [];
let nativeTitle = 0;
const titleHits = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = raw.split("\n");
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;

  // 规则一：禁原生弹窗。确认动作和提示必须使用应用内组件。
  for (const re of [/\bwindow\.(confirm|alert|prompt)\s*\(/g, /(?<![\w.])(confirm|alert|prompt)\s*\(/g]) {
    let m;
    while ((m = re.exec(src))) {
      const line = lineAt(m.index);
      if (EXEMPT.test(lines[line - 1])) continue;
      dialogHits.push(`${relative(ROOT, file)}:${line}  ${lines[line - 1].trim()}`);
    }
  }

  // 规则二：原生 title 属性（用可见文本或应用内提示代替）。只数小写开头的 HTML 标签上的，
  // `<Modal title=...>` 这类组件 prop 不算。
  const re = /\btitle=/g;
  let m;
  while ((m = re.exec(src))) {
    let tag = null;
    for (let j = m.index; j >= 0; j--) {
      if (src[j] === "<" && /[A-Za-z]/.test(src[j + 1] ?? "")) {
        tag = /^[A-Za-z][\w.-]*/.exec(src.slice(j + 1))[0];
        break;
      }
    }
    if (!tag || !/^[a-z]/.test(tag)) continue;
    const line = lineAt(m.index);
    if (EXEMPT.test(lines[line - 1])) continue;
    nativeTitle++;
    titleHits.push(`${relative(ROOT, file)}:${line}  <${tag} title=…>`);
  }
}

let failed = false;

// shell 脚本里 `$VAR` 紧跟非 ASCII 字符（典型：中文标点）会被 bash 吞掉一个字节
// 当成变量名的一部分：macOS 的 bash 扫描标识符时不认多字节边界，于是
// `echo ":$PORT。"` 里的变量名成了 `PORT\xe3`，在 `set -u` 下直接 unbound
// variable 退出。实测复现：bash -c 'set -u; PORT=1; echo ":$PORT。"'
// 症状很坑：脚本前面的输出都正常，到这一行才突然报错退出，看着像别处的问题
// （2026-07-31 restart.sh 的安全闸就是这样断在最后一句提示上）。
// 修法只有一个：加花括号 `${PORT}`。
const shellHits = [];
for (const rel of execFileSync("git", ["ls-files", "*.sh"], { cwd: ROOT, encoding: "utf8" }).split("\n")) {
  if (!rel.trim()) continue;
  let src;
  try {
    src = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue; // 已删除但仍在索引里
  }
  src.split("\n").forEach((line, i) => {
    if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) {
      shellHits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 72)}`);
    }
  });
}
if (shellHits.length) {
  failed = true;
  console.error(`\n✗ shell 脚本里 $变量 紧跟着非 ASCII 字符（${shellHits.length} 处）：`);
  for (const h of shellHits) console.error("   " + h);
  console.error("   bash 会把那个字符的首字节吞进变量名，set -u 下当场 unbound variable 退出。");
  console.error("   改成 ${VAR} 加花括号即可。\n");
}

// shared/ 的 package.json exports 指向 **源码** src/*.ts，所以 shared/src 里的相对
// 导入说明符是 node 直接拿去找文件的真实路径 —— 写 `./x.js` 时 src 目录下并没有那个
// 文件，node 当场 ERR_MODULE_NOT_FOUND（2026-08-04 服务端起不来就是这样：
// workflow-presets.ts 引入了 shared 里第一个跨文件**值**导入，在此之前全是
// `import type`，被类型剥离一并删掉，所以坏写法潜伏了很久才爆）。
// 正确写法是 `./x.ts`：node/tsx/vite/metro 都能解析，tsc 靠
// rewriteRelativeImportExtensions 在 emit 到 shared/dist 时重写回 .js。
// 这里连 `import type` 一起拦：今天是类型导入、明天改成值导入就是一颗定时炸弹。
const sharedSpecHits = [];
for (const file of walk(join(ROOT, "shared/src"))) {
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = raw.split("\n");
  for (const re of [/\bfrom\s+"(\.[^"]*)"/g, /\bimport\s*\(\s*"(\.[^"]*)"/g]) {
    let m;
    while ((m = re.exec(src))) {
      if (m[1].endsWith(".ts")) continue;
      const line = src.slice(0, m.index).split("\n").length;
      sharedSpecHits.push(`${relative(ROOT, file)}:${line}  ${lines[line - 1].trim().slice(0, 72)}`);
    }
  }
}
if (sharedSpecHits.length) {
  failed = true;
  console.error(`\n✗ shared/src 里的相对导入没写 .ts 后缀（${sharedSpecHits.length} 处）：`);
  for (const h of sharedSpecHits) console.error("   " + h);
  console.error("   shared 的 exports 指向源码，说明符就是 node 拿去找文件的真实路径：");
  console.error("   `./x.js` 和无后缀的 `./x` 在运行时都不存在，一旦变成值导入就 ERR_MODULE_NOT_FOUND。");
  console.error("   一律写 `./x.ts`（tsc emit 到 dist 时会自动重写回 .js）。\n");
}

if (dialogHits.length) {
  failed = true;
  console.error(`\n✗ 用了浏览器原生弹窗（${dialogHits.length} 处）：`);
  for (const h of dialogHits) console.error("   " + h);
  console.error("   确认对话框复用 web-next/src/task-detail/ConfirmDialog.tsx，其它弹层和提示沿用现有应用内组件。");
  console.error("   原生弹窗样式不一致、阻塞、且无法做成应用风格。\n");
}

if (nativeTitle > NATIVE_TITLE_BASELINE) {
  failed = true;
  console.error(`\n✗ 原生 title 属性从 ${NATIVE_TITLE_BASELINE} 涨到了 ${nativeTitle} 处，新增的请改用可见文本或应用内提示组件：`);
  for (const h of titleHits.slice(-(nativeTitle - NATIVE_TITLE_BASELINE) * 3)) console.error("   " + h);
  console.error("   任务列表这类每秒重渲染的界面会不断打断原生 tooltip 的悬停计时器，气泡永远弹不出来。\n");
} else if (nativeTitle < NATIVE_TITLE_BASELINE) {
  console.log(`[conventions] 原生 title 已降到 ${nativeTitle} 处（基线 ${NATIVE_TITLE_BASELINE}），把 scripts/check-conventions.mjs 里的基线调下来锁住成果。`);
}

if (failed) process.exit(1);
console.log(`[conventions] 通过：原生弹窗 0 处，原生 title ${nativeTitle} 处（基线 ${NATIVE_TITLE_BASELINE}）。`);
