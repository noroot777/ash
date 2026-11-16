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
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
