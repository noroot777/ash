/**
 * 门禁按**产物**对待、不逐文件冻结的依赖目录名。
 *
 * 单独一个文件是为了让收口（accept-gate-confine）和依赖放置（accept-gate-deps）共用同一份名单
 * 而不互相 import——两边都需要它，循环依赖会让其中一侧拿到 undefined。
 */
export const DEPENDENCY_DIRS = ["node_modules", ".venv", "vendor", "target"];
