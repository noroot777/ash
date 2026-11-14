// 代码根与数据根的**纯解析**：只看传进来的环境，不在加载时读 process.env（那是 paths.js 的事），
// 所以要在 paths.js 冻成常量之前、或者替别的环境算数据根的地方也能用。
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

// 这份 ash 的代码根：server/、web/、mcp/ 的产物都在它底下。src 与编译后的 dist 都在
// server/ 下一层，所以 ../.. 两种跑法都指向同一处。它**不一定是仓库**：独立打包的 app
// 里它是 bundle 的 Contents/Resources，只读。
export const CODE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 运行时写出的一切（库、锁、exits 账、runs、uploads、deps……）的根。
 *
 * `ASH_DATA_DIR` 整体指定；不设时锚在 `<代码根>/data`，不随启动 cwd 漂移（`npm start`、
 * `npm -w server`、`tsx` 落在同一处）。`ASH_DB`、`ASH_RUNS_DIR` 这些单项覆盖照旧优先，
 * 由各自的读取点处理。
 */
export function dataRootFor(env: { ASH_DATA_DIR?: string | undefined }): string {
  const explicit = env.ASH_DATA_DIR?.trim();
  return explicit ? resolve(explicit) : join(CODE_DIR, "data");
}
