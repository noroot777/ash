// 代码根与数据根的**纯解析**：只看传进来的环境，不在加载时读 process.env（那是 paths.js 的事），
// 所以要在 paths.js 冻成常量之前、或者替别的环境算数据根的地方也能用。
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readStorageEnv } from "@ash/shared/env-names";

// 这份 ash 的代码根：server/、web/、mcp/ 的产物都在它底下。src 与编译后的 dist 都在
// server/ 下一层，所以 ../.. 两种跑法都指向同一处。它**不一定是仓库**：独立打包的 app
// 里它是 bundle 的 Contents/Resources，只读。
export const CODE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 运行时写出的一切（库、锁、exits 账、runs、uploads、deps……）的根。
 *
 * `NAVI_DATA_DIR` 整体指定；不设时锚在 `<代码根>/data`，不随启动 cwd 漂移（`npm start`、
 * `npm -w server`、`tsx` 落在同一处）。`NAVI_DB`、`NAVI_RUNS_DIR` 这些单项覆盖照旧优先，
 * 由各自的读取点处理。
 */
export function dataRootFor(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = readStorageEnv(env, "NAVI_DATA_DIR");
  return explicit ? resolve(explicit) : join(CODE_DIR, "data");
}
