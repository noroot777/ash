// 清理证据层的**绕过闸**，挂在 server build 前置（`npm -w server run build`）。
//
// 为什么需要它：`CleanupResult` 的 `empty` 那一档身上有一个私有 unique symbol，于是
// 「手上攥着没排除掉的号却答空」在类型层就编译不过，唯一的出口是 `sweptClean(open)`
// （它先核销再答，见 server/src/executors/cleanup-result.ts 的闸一）。可类型断言能把
// 这道闸整个绕开 —— `{ kind: "empty" } as CleanupResult` 在 TS 里是合法的，而它恰好就是
// 这一条判据错误（「没进这次的视野」当成「没有未销的责任」）过去十轮反复复发的写法。
//
// 挂 server build 而不是前端那条 check-conventions：这里扫的是 server/src，而 server 上线的
// 唯一通道是 build → dist（与 web 的 build → web/dist 对称）。两条闸触发时机不同，不捆一起。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "server/src");
// 全仓唯一允许构造 `empty` 的地方：那个 symbol 没有值，连本模块也只能断言一次。
const OWNER = "server/src/executors/cleanup-result.ts";

// 注释抹成等长空格再扫（行号列偏移都还对得上），否则这份文件自己的说明文字就会被当成违规。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
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

const hits = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (rel === OWNER) continue;
  const src = stripComments(readFileSync(file, "utf8"));
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    // ① 断言成结论类型：绕开 `empty` 那道 symbol 闸，也绕开「另外三档 open 必填」。
    // ② 手写 `kind: "empty"`：类型层已经拦住了，但写法本身一出现就说明有人在找后门
    //    （比如先 `as any` 再构造），所以一并拦，报错里直接给出替代写法。
    if (/\bas\s+(unknown\s+as\s+)?CleanupResult\b/.test(line) || /kind:\s*"empty"/.test(line)) {
      hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 78)}`);
    }
  });
}

if (hits.length) {
  console.error(`\n✗ 绕过了清理结论的类型闸（${hits.length} 处）：`);
  for (const h of hits) console.error("   " + h);
  console.error("   `empty` 只能由 sweptClean(open) / nothingToCollect() 产出：前者先把你手上的");
  console.error("   名单核销一遍，剩一条就自动降成 unknown；后者是「压根没有要收的东西」。");
  console.error("   断言绕过这道闸，等于把「没进这次的视野」又当成「没有未销的责任」。\n");
  process.exit(1);
}
console.log("[cleanup-evidence] 通过：结论类型没有被断言绕过。");
