// 「这次回填动的是哪一套资源」—— 把归属判断从命令行外壳里拎出来，单独一层、可单测。
//
// **一套资源 = 一个库文件 + 它的 runs 目录**。账在 `sessions` 里，`result` 的原始数字在
// `data/runs/<task>/<session>.trace.jsonl` 里，回填两边都要改。而这两样东西原本由**两个
// 互不相干的环境变量**各自解析（`ASH_DB` / `ASH_RUNS_DIR`），于是 `--db /tmp/copy.db` 换
// 掉的只是库，trace 仍然指着正式那份 —— 「先在拷贝上验证」这条前提当场失效，一跑 `--apply`
// 就把真实历史改写了（第 2 轮审查 F1 实测）。
//
// 所以归属在这里显式决定，而且是**成套**决定。判据三条，缺一条都挡不住：
//
// ① **归属**：`<dir>/runs` 的主人是 `<dir>/ash.db`，别的库文件对它没有写权。
//    「同级」只是必要条件，不是归属 —— 同一个目录里可以放第二份库（生产 `data/` 里就有
//    `ash.db` 和历史遗留的 `harness.db`），拿 `--db <dir>/check.db --apply` 过「同级」这关
//    之后，改写的恰恰是 `ash.db` 的 trace（第 1 轮审查 F1 实测 `SOURCE_TRACE_CHANGED`）。
//    这也是为什么判据不能写成「目录里只有一个 .db」—— 那条会把真正的生产库自己挡掉。
// ② **配套**：runs 必须正好是目标库的同级 `runs/`，对不上一律拒绝，没有放行开关 ——
//    「一个可写的库指向一份它并不拥有的原始目录」这种组合谁都没要求过。
// ③ **规范化之后再比**：两边都先过 `canonicalResourceKey`（realpath）。不然
//    `<拷贝>/runs` 只要是一条指向正式 runs 的软链，字符串上它就是「同级 runs」，写下去
//    动的却是真实历史。规范化同时保证锁键唯一：同一份资源经软链/别名到达时，ash 启动和
//    这个脚本算出的键必须是同一个，否则两把锁各锁一个名字，等于没锁。
//
// dry-run 不写任何东西，所以三条都只在 `--apply` 时生效（拿正式 runs 给拷贝库预览清单，
// 不用拷 10G）。
//
// **这个文件不许 import paths.js**：那一份在模块加载时就把 `ASH_RUNS_DIR` 读成了常量，
// 而这里的活儿恰恰是在那之前决定该把环境变量设成什么。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalResourceKey } from "./resource-claim.js";

/** `<dir>/runs` 的主人只能叫这个名字。 */
const OWNER_DB_NAME = "ash.db";

export type RepairResourceDecision = {
  dbFile: string;
  runsDir: string;
  /** 跟目标库配套的那份 runs（判据）。 */
  pairedRuns: string;
  productionDb: string;
  /** 这次要锁住的全部资源键（库 + runs，已规范化去重排序）。 */
  lockKeys: string[];
  /** 非 null = 拒绝动手，这段话原样打给人看。 */
  refusal: string | null;
};

export function resolveRepairResources(request: {
  /** `--db`。 */
  db?: string | undefined;
  /** `--runs`。 */
  runs?: string | undefined;
  apply: boolean;
  forceProduction?: boolean;
  env?: { ASH_DB?: string | undefined; ASH_RUNS_DIR?: string | undefined };
  /** 只给测试用：伪造仓库的 data 目录。 */
  dataDir?: string;
}): RepairResourceDecision {
  const dataDir = request.dataDir
    ? resolve(request.dataDir)
    : fileURLToPath(new URL("../../data", import.meta.url));
  const productionDb = canonicalResourceKey(join(dataDir, OWNER_DB_NAME));
  const env = request.env ?? {};
  const dbFile = canonicalResourceKey(
    request.db ? resolve(request.db) : env.ASH_DB ? resolve(env.ASH_DB) : productionDb,
  );
  // 故意**不**对 pairedRuns 再做一次 realpath：它是「目标库同级那个名字」这条判据本身，
  // 要用它去比对方规范化后的真实落点。两边都 realpath 的话，一条指向正式 runs 的软链会
  // 让「同级」这关自动成立。
  const pairedRuns = join(dirname(dbFile), "runs");
  const runsDir = canonicalResourceKey(
    request.runs
      ? resolve(request.runs)
      // 指了库没指 runs：按「一套资源」解析，环境里那份（很可能是正式 runs）不作数。
      : request.db
        ? pairedRuns
        : env.ASH_RUNS_DIR
          ? resolve(env.ASH_RUNS_DIR)
          : join(dataDir, "runs"),
  );

  const refusal = request.apply
    ? applyRefusal({ dbFile, runsDir, pairedRuns, productionDb, dataDir, force: !!request.forceProduction })
    : null;
  const lockKeys = [...new Set([dbFile, runsDir])].sort();
  return { dbFile, runsDir, pairedRuns, productionDb, lockKeys, refusal };
}

function applyRefusal(input: {
  dbFile: string;
  runsDir: string;
  pairedRuns: string;
  productionDb: string;
  dataDir: string;
  force: boolean;
}): string | null {
  // **「像不像生产库」按路径形状判，不只跟本检出的 data/ash.db 比**：从 worktree 里跑的时候
  // 本检出的 data/ 根本不存在，而 `--db /Users/x/code/ash/data/ash.db` 指的恰恰是主检出那份
  // 真生产库 —— 只比一个等号的话，那条最该拦的用法反而一路放行。
  const productionLike = input.dbFile === input.productionDb
    || (basename(input.dbFile) === OWNER_DB_NAME && basename(dirname(input.dbFile)) === "data");
  if (productionLike && !input.force) {
    return `拒绝对生产库动手：${input.dbFile}\n`
      + "先拷一套出来验证（库 + runs 一起，见脚本文件头用法 ①），确认无误后加 --force-production，并且先停掉 ash。";
  }
  // 归属：runs 目录的主人是它同级那个 ash.db，别的库对它没有写权。
  if (basename(input.dbFile) !== OWNER_DB_NAME) {
    return `拒绝动手：这份库不是 ${input.pairedRuns} 的主人\n`
      + `  库   ${input.dbFile}\n  runs ${input.pairedRuns}（主人是 ${join(dirname(input.dbFile), OWNER_DB_NAME)}）\n`
      + `回填要连 trace 一起改，而 trace 属于同级那个 ${OWNER_DB_NAME} —— 拿同目录的第二份库来跑，`
      + "改写的是别人的历史。拷贝验证请整套拷出去、库就叫 ash.db：\n"
      + `  mkdir -p /tmp/ash-check && cp ${join(dirname(input.dbFile), OWNER_DB_NAME)} /tmp/ash-check/${OWNER_DB_NAME}`
      + ` && cp -R ${input.pairedRuns} /tmp/ash-check/runs`;
  }
  if (input.runsDir !== input.pairedRuns) {
    const source = existsSync(join(input.dataDir, "runs")) ? join(input.dataDir, "runs") : "<你的正式 data/runs>";
    return `拒绝动手：库和 runs 不是配套的一套\n`
      + `  库   ${input.dbFile}\n  runs ${input.runsDir}（规范化后的真实落点）\n  应为 ${input.pairedRuns}\n`
      + "这次回填要同时改库和 trace 文件，两边必须属于同一套资源 —— 否则就成了「改拷贝的账、"
      + "改正式的 trace」。软链也算不配套：名字对不代表落点对。拷贝验证请把 runs 一起拷：\n"
      + `  cp -R ${source} ${input.pairedRuns}`;
  }
  return null;
}
