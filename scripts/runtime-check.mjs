// 这台机器的 Node / npm 带不带得动 navi。setup.mjs(装机)和 upgrade.mjs(升级前)共用。
import { createRequire } from "node:module";

/** 报错时给的那个说得出口的目标版本;真正的判据是下面那条能力检查。 */
export const NODE_MIN = "22.16.0";

/**
 * Node 不比版本号,直接问能力:navi 的数据库是 Node 内置的 `node:sqlite`,而它到位的
 * 时间比大版本号细得多 —— 22.13~22.15 有模块却没有 `StatementSync.setReturnArrays`
 * (缺了它 join 出的重名列会**静默**读错),23.x 一路到 23.7 也还不行,22.16 和 24 才是全的。
 * 所以这里当场跑一遍 navi 真正用到的调用。
 *
 * 必须用 createRequire 而不是 import:ESM 的静态 import 在链接期就解析,Node 20
 * 上整个脚本一行都执行不到就先抛 ERR_UNKNOWN_BUILTIN_MODULE —— 那正是这条检查要替用户
 * 翻译掉的错。
 */
export function sqliteUsable() {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      return typeof db.prepare("select 1").setReturnArrays === "function";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

const parts = (v) => String(v).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);

/**
 * version 满不满足 range。只认 package.json 里实际写的那一种形状:`>=x.y.z`(可以有几段用空格隔开);
 * 认不出的范围返回 null —— 交给调用方说「没核对」,不替人猜成满足或不满足。
 */
export function satisfiesRange(version, range) {
  const clauses = String(range ?? "").trim().split(/\s+/).filter(Boolean);
  if (!clauses.length || !clauses.every((c) => /^>=\d+(\.\d+){0,2}$/.test(c))) return null;
  const have = parts(version);
  return clauses.every((c) => {
    const want = parts(c.slice(2));
    for (let i = 0; i < 3; i += 1) if (have[i] !== want[i]) return have[i] > want[i];
    return true;
  });
}
