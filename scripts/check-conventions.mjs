// 前端约定的 grep 闸，挂在 web build 前置（`npm -w web run build`）。
// 挂这里而不是 pre-commit：这两条要在「前端代码上线前」拦住，而 server 从磁盘读 web/dist，
// 不 build 就不生效——build 是前端改动上线的唯一通道，等价于每次前端上线都跑一遍。
// （根文件体积闸走的是另一个通道 .githooks/pre-commit：两条规则的触发时机不同，不捆一起。）
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web/src");

// 原生 title 的存量。CLAUDE.md 的约定是「改到它时顺手迁移，不必专门做一轮」，
// 所以这条是棘轮：存量不拦、新增才拦。顺手迁移几个之后把这个数字调低即可。
const NATIVE_TITLE_BASELINE = 128;

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

  // 规则一：禁原生弹窗。确认对话框用 ConfirmModal、其它弹层用 Modal、报错提示用 toast。
  for (const re of [/\bwindow\.(confirm|alert|prompt)\s*\(/g, /(?<![\w.])(confirm|alert|prompt)\s*\(/g]) {
    let m;
    while ((m = re.exec(src))) {
      const line = lineAt(m.index);
      if (EXEMPT.test(lines[line - 1])) continue;
      dialogHits.push(`${relative(ROOT, file)}:${line}  ${lines[line - 1].trim()}`);
    }
  }

  // 规则二：原生 title 属性（用 Tip 代替）。只数小写开头的 HTML 标签上的，
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

if (dialogHits.length) {
  failed = true;
  console.error(`\n✗ 用了浏览器原生弹窗（${dialogHits.length} 处）：`);
  for (const h of dialogHits) console.error("   " + h);
  console.error("   确认对话框用 ConfirmModal、其它弹层用 Modal（web/src/Modal.tsx），报错/提示用 toast（web/src/toast.tsx）。");
  console.error("   原生弹窗样式不一致、阻塞、且无法做成应用风格。\n");
}

if (nativeTitle > NATIVE_TITLE_BASELINE) {
  failed = true;
  console.error(`\n✗ 原生 title 属性从 ${NATIVE_TITLE_BASELINE} 涨到了 ${nativeTitle} 处，新增的请改用 Tip（web/src/Tip.tsx）：`);
  for (const h of titleHits.slice(-(nativeTitle - NATIVE_TITLE_BASELINE) * 3)) console.error("   " + h);
  console.error("   任务列表这类每秒重渲染的界面会不断打断原生 tooltip 的悬停计时器，气泡永远弹不出来。\n");
} else if (nativeTitle < NATIVE_TITLE_BASELINE) {
  console.log(`[conventions] 原生 title 已降到 ${nativeTitle} 处（基线 ${NATIVE_TITLE_BASELINE}），把 scripts/check-conventions.mjs 里的基线调下来锁住成果。`);
}

if (failed) process.exit(1);
console.log(`[conventions] 通过：原生弹窗 0 处，原生 title ${nativeTitle} 处（基线 ${NATIVE_TITLE_BASELINE}）。`);
