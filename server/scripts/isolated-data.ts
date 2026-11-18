// 给「静态 import 了会碰库的模块」的测试用：放在 import 列表的**第一行**。
//
// 库在 src/db/index.ts 加载那一刻就打开，数据目录在 src/paths.ts 加载那一刻就定下来 —— 都早于
// 测试正文里的任何一句 `process.env.X = …`（静态 import 先于正文执行）。不先指到临时目录，
// 开的就是这份检出自己的 data/ash.db，写的就是它的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEnv } from "@ash/shared/env-names";

const root = mkdtempSync(join(tmpdir(), "ash-test-data-"));
// 先把继承来的各代名字擦掉：环境里留着一个 `NAVI_DB`（比如从预览实例底下起的），新名优先，这里设的
// 就白设了。设的仍是旧名，因为后面的测试正文还拿旧名改指（见下）。
for (const name of ["NAVI_DB", "NAVI_DATA_DIR"] as const) clearEnv(process.env, name);
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_DATA_DIR = join(root, "data");
// 进程退出那一刻库还开着（测试自己另开的句柄也一样）：Windows 上删不掉打开着的文件（EBUSY），在 exit
// 钩子里抛出来会把测试的退出码改成 1。删不掉就留着 —— 门禁给每条叶子另给了系统临时目录，叶子跑完随它一起删。
// 不能为了退出时先关库而在这里提前 import 库模块：有的测试导入这份夹具之后还要改 ASH_DB / ASH_RUNS_DIR /
// ASH_UPLOADS_DIR 再动态导入产品模块（test-agent-image-entry、test-agent-image-stream、test-chat-boundary
// 等），提前开库就把它们的目录全定死在这里了，这几条会红。
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 见上 */
  }
});
