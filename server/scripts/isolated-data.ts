// 给「静态 import 了会碰库的模块」的测试用：放在 import 列表的**第一行**。
//
// 库在 src/db/index.ts 加载那一刻就打开，数据目录在 src/paths.ts 加载那一刻就定下来 —— 都早于
// 测试正文里的任何一句 `process.env.X = …`（静态 import 先于正文执行）。不先指到临时目录，
// 开的就是这份检出自己的 data/ash.db，写的就是它的 data/。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-test-data-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_DATA_DIR = join(root, "data");
// 删目录之前必须先松开库(Windows 删不掉还开着的文件,理由见 tmp-db.ts)。退出回调里不能 await,
// 所以趁现在把连接拿在手上 —— 用这份夹具的测试反正一加载产品模块就会开它;关库本身是同步的。
const { dbClient } = await import("../src/db/index.js");
process.on("exit", () => {
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
});
