// 清理证据层的**绕过闸**，挂在 server build 前置（`npm -w server run build`）。
//
// 两条，都是「类型层拦不住、而历史上真的被绕过过」的那种：
//
// ① **断言绕过结论类型**。`CleanupResult` 的 `empty` 那一档身上有一个私有 unique symbol，
//    于是「手上攥着没排除掉的号却答空」在类型层就编译不过，唯一的出口是 `sweptClean(open)`
//    （它先核销再答，见 server/src/executors/cleanup-result.ts 的闸一）。可类型断言能把这道
//    闸整个绕开 —— `{ kind: "empty" } as CleanupResult` 在 TS 里是合法的，而它恰好就是这一条
//    判据错误（「没进这次的视野」当成「没有未销的责任」）过去十轮反复复发的写法。
//
// ② **消费了记号证据的 `ours`，却没把成员交进责任集合**。`ours` 自带 pid + 同源代次，是整条
//    链上最硬的归属证明，可它跨不过 `exec`：成员换一个干净环境之后 pid 和那一代一个字没变，
//    记号那一问却从此答 `none`。所以每一处消费 `ours` 的地方都必须经 `unitOpen` 把身份交出去
//    （第 11 轮审查 F1 实测：少了这一步，刚朝它开过刀的成员在下一句被判成「没有」，行被删，
//    而进程还在写）。这一条是**文件级**的粗判（出现 `ours` 的文件必须也出现 `unitOpen`）：
//    精确到表达式需要类型信息，而这里只要能在「新写一处消费点却忘了交身份」时叫住人就够了。
//
// 挂 server build 而不是前端那条 check-conventions：这里扫的是 server/src，而 server 上线的
// 唯一通道是 build → dist（与 web 的 build → web/dist 对称）。两条闸触发时机不同，不捆一起。
import { readdirSync, statSync, readFileSync } from "node:fs";
import nodePath, { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 全仓唯一允许构造 `empty` 的那个模块。**拆成路径段而不是写死一个带斜杠的字符串**：
// 上一版用 `relative(ROOT, file)` 的结果去跟 `"server/src/executors/cleanup-result.ts"` 逐字比，
// 而 Windows 原生 `relative` 返回的是 `server\src\executors\cleanup-result.ts` —— 恒不等，于是
// owner 自己那几处合法定义被当成绕过，build 前置退 1、tsc 压根跑不到（第 11 轮审查 F3）。
export const OWNER_SEGMENTS = ["server", "src", "executors", "cleanup-result.ts"];

/**
 * 这个文件是不是 owner。按**绝对路径**比，而且用调用方给的那套 path 语义 —— 于是它跟
 * `walk()` 产出的路径一定同构（两边都是 `join` 出来的），不依赖分隔符长什么样。
 * `impl` 只为回归能用 `path.win32` / `path.posix` 各跑一遍（见 test-cleanup-evidence-guard.ts）。
 */
export const isOwnerFile = (file, root, impl = nodePath) =>
  impl.resolve(file) === impl.resolve(impl.join(root, ...OWNER_SEGMENTS));

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

function main() {
  const hits = [];
  const unfiled = [];
  for (const file of walk(join(ROOT, "server/src"))) {
    const rel = relative(ROOT, file);
    const owner = isOwnerFile(file, ROOT);
    const src = stripComments(readFileSync(file, "utf8"));
    if (!owner) {
      src.split("\n").forEach((line, i) => {
        // 手写 `kind: "empty"` 本身已经编译不过，但写法一出现就说明有人在找后门（比如先
        // `as any` 再构造），所以一并拦，报错里直接给出替代写法。
        if (/\bas\s+(unknown\s+as\s+)?CleanupResult\b/.test(line) || /kind:\s*"empty"/.test(line)) {
          hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 78)}`);
        }
      });
    }
    // ②：只看 executors/ 这一棵子树 —— 哨兵回收（monitor-reclaim-evidence.ts）消费的是同一个
    // 证据类型，但那条链路没有「责任表」这一层，它的语义是「敢不敢杀」而不是「欠不欠账」。
    if (!rel.includes(join("server", "src", "executors")) && !rel.includes("server/src/executors")) continue;
    if (owner) continue;
    if (/verdict === "ours"|case "ours"/.test(src) && !/\bunitOpen\b/.test(src)) {
      unfiled.push(rel);
    }
  }

  let failed = false;
  if (hits.length) {
    failed = true;
    console.error(`\n✗ 绕过了清理结论的类型闸（${hits.length} 处）：`);
    for (const h of hits) console.error("   " + h);
    console.error("   `empty` 只能由 sweptClean(open) / nothingToCollect() 产出：前者先把你手上的");
    console.error("   名单核销一遍，剩一条就自动降成 unknown；后者是「压根没有要收的东西」。");
    console.error("   断言绕过这道闸，等于把「没进这次的视野」又当成「没有未销的责任」。\n");
  }
  if (unfiled.length) {
    failed = true;
    console.error(`\n✗ 消费了记号证据的 ours，却没把成员交进责任集合（${unfiled.length} 个文件）：`);
    for (const f of unfiled) console.error("   " + f);
    console.error("   ours 自带 pid + 同源代次，但它跨不过 exec：成员换一个干净环境之后，记号那");
    console.error("   一问就答 none 了。所以消费它的地方必须经 unitOpen(evidence, why) 把身份交进");
    console.error("   责任集合（openLedger / open 字段），只有退出证据才能让它消失。\n");
  }
  if (failed) process.exit(1);
  console.log("[cleanup-evidence] 通过：结论类型没有被断言绕过，ours 的成员都交进了责任集合。");
}

// 被 import 时（回归要调 isOwnerFile）不自动跑整棵扫描。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
