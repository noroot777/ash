// 几个测试会 `ensureSchema()` 并往库里真写数据。ASH_DB 指错地方 = 直接改用户
// 的真实任务库,所以每个都在入口挡一道「这个库必须是临时的」。
//
// 判据以前写死 `startsWith("/tmp/")`,那在 Windows 上是**永远为假**:那边根本没有
// `/tmp`,临时目录是 `%TEMP%`(形如 `C:\Users\<你>\AppData\Local\Temp`)。于是这几条
// 测试在 Windows 上不是失败而是拒跑,还甩出一句「防止误改真实数据」—— 看到的人只会
// 以为自己命令写错了。
//
// 同时 `/tmp` 也不能删:macOS 的 `os.tmpdir()` 返回的是 `$TMPDIR`(`/var/folders/…`),
// 跟 `/tmp` 不是一个目录,而现有的跑法全是 `ASH_DB=/tmp/xxx.db`。两个都认。
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { IS_WINDOWS, PATH_SEP, isInsidePath } from "../src/platform.js";

// `resolve` 顺手把 Windows 上的正斜杠写法(`C:/…/Temp/x.db`)归一成反斜杠,
// 否则按 `\` 做前缀比较会漏判。
function underTemp(dbPath: string): boolean {
  const roots = IS_WINDOWS ? [tmpdir()] : [tmpdir(), "/tmp"];
  return roots.some((root) => isInsidePath(resolve(root), resolve(dbPath), PATH_SEP));
}

/**
 * 没设 ASH_DB、或者它不在临时目录下,就打印怎么跑并 `exit(1)`。
 * `name` 用来拼示例命令,给测试自己的名字即可。
 */
export function requireTmpDb(name: string): void {
  const dbPath = process.env.ASH_DB;
  const example = `${tmpdir()}${PATH_SEP}${name}-${Date.now()}.db`;
  if (!dbPath) {
    console.error(`先设 ASH_DB 再跑,比如 ASH_DB=${example}`);
    process.exit(1);
  }
  if (!underTemp(dbPath)) {
    console.error(`ASH_DB 必须在临时目录下(防止误改真实数据):${tmpdir()}${IS_WINDOWS ? "" : " 或 /tmp"}`);
    console.error(`当前值:${dbPath}`);
    process.exit(1);
  }
}

/**
 * 删临时舞台**之前**先松开数据库文件。
 *
 * Windows 删不掉「还开着的文件」,而这些测试的 ASH_DB 就落在舞台目录里 ——
 * import 任何碰库的模块时就连上了,收尾那句 `rmSync(stage)` 于是必然 EBUSY:
 * 断言全过,却在最后一步把整条测试判红。POSIX 上删已打开的文件是合法的,所以这句
 * 在开发机上是空转,只有真 Windows 上才救得到命(2026-08-18 实测:file-browser、
 * local-open、review-flow、accept-merge、scheduled-messages、path-boundary 六条同病)。
 *
 * 故意吞掉异常:没连过库的测试调它也该是无害的。
 */
export async function releaseTmpDb(): Promise<void> {
  await import("../src/db/index.js")
    .then(({ dbClient }) => dbClient.close())
    .catch(() => undefined);
}
