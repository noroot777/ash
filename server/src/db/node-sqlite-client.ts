// Node 内置 `node:sqlite` 的 libsql 客户端外壳。
//
// **为什么换掉 @libsql/client**：它是 N-API 预编译原生模块，Windows 上 npm 装不到
// 对应架构的 prebuilt 就得现场 node-gyp（要 Visual Studio Build Tools），这是
// Windows 用户第一步 `npm install` 就翻车的头号原因。`node:sqlite` 是 Node 自带的，
// 零编译、零下载，Windows/macOS/Linux 行为一致。
//
// **为什么是外壳而不是换 drizzle 驱动**：
// - `drizzle-orm/sqlite-proxy` 不支持真事务——它的 session 没有 `transaction()`，
//   `db.transaction()` 会退化成「照常执行、出错不回滚」。本仓库到处在用
//   `db.transaction()`，静默失去原子性比装不上还糟。
// - `drizzle-orm/better-sqlite3` 是**同步**驱动，`db.transaction(async …)` 不成立。
// - 这个版本的 drizzle-orm(0.38.4) 没有 node:sqlite 驱动。
// 所以继续用 `drizzle-orm/libsql`，只把它下面那个 `Client` 换成本文件——它要的接口
// 一共就 `execute` / `batch` / `migrate` / `transaction` 四个方法，都在下面实现了。
//
// **Row 的形状是硬约束，不能简化成普通对象**：drizzle 的 libsql session 对同一个 row
// 同时用两种读法——`normalizeRow` 走 `Object.keys()` 拿列名，`mapResultRow` 走
// `Array.prototype.slice.call(row)` 拿**位置**。所以 row 必须：具名列可枚举、数字下标
// 和 `length` 不可枚举。少一样就有一条路读到空。join 出重名列（`t.id` 和 `p.id` 都叫
// `id`）时位置读法是唯一正确的那条，因此取值一律走 `setReturnArrays(true)` 的数组结果，
// 具名属性只是在数组之上再贴一层。
import { createRequire } from "node:module";
import type { DatabaseSync as Db, SQLInputValue, StatementSync } from "node:sqlite";

/**
 * 能跑起来的最低 Node。这个下限**不是**「node:sqlite 从哪版开始有」(22.5 就有了),
 * 而是「`StatementSync.setReturnArrays` 从哪版开始有」—— 见 prepare() 里那段。
 * 同一个数字还写在 `package.json` 的 engines 和 `scripts/setup.mjs` 的环境检查里。
 */
const MIN_NODE = "22.16.0";

// 为什么不用静态 import:ESM 的静态 import 在**链接期**就解析完,Node 20 上整张模块图
// 一行都还没开始执行就抛 ERR_UNKNOWN_BUILTIN_MODULE —— 实测连 import 语句上面的
// console.log 都不会打印,任何写在代码里的提示都来不及说。改成执行期 require,才有机会
// 把「Node 太旧」这句人话递出去,而不是让人对着一个内置模块名发愣。
const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): typeof import("node:sqlite") {
  try {
    return nodeRequire("node:sqlite") as typeof import("node:sqlite");
  } catch {
    throw new Error(
      `ash 的数据库用的是 Node 自带的 node:sqlite,当前 Node ${process.version} 没有这个模块。` +
      `升级到 >= ${MIN_NODE} 就好(node -v 看当前版本)。`,
    );
  }
}

const { DatabaseSync } = loadSqlite();
assertUsable();

function assertUsable(): void {
  // 有模块还不够。22.13~22.15 有 node:sqlite,却还没有 `StatementSync.setReturnArrays`
  // (22.16 才加)。缺了它就只能按列名读,join 出的重名列(`t.id` 和 `p.id` 都叫 `id`)
  // 会互相覆盖 —— 那是**静默**读到错行,比起不来危险得多。所以花一次 in-memory prepare
  // 当场问清楚,而不是靠版本号推断。
  const probe = new DatabaseSync(":memory:");
  try {
    if (typeof probe.prepare("select 1").setReturnArrays !== "function") {
      throw new Error(
        `当前 Node ${process.version} 自带的 node:sqlite 还没有 StatementSync.setReturnArrays,` +
        `ash 读多表 join 会拿到错的列。升级到 >= ${MIN_NODE}。`,
      );
    }
  } finally {
    probe.close();
  }
}

export type SqlValue = null | string | number | bigint | Uint8Array;
export type InValue = SqlValue | undefined | boolean | Date;
export type InArgs = InValue[] | Record<string, InValue>;
export type InStatement = string | { sql: string; args?: InArgs };
export type TransactionMode = "write" | "read" | "deferred";

/** libsql 的 Row：具名列可枚举，数字下标与 length 不可枚举（见文件头）。 */
export interface Row {
  [key: string]: SqlValue;
  [index: number]: SqlValue;
  length: number;
}

export interface ResultSet {
  rows: Row[];
  columns: string[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

export interface Transaction {
  execute(stmt: InStatement): Promise<ResultSet>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void;
}

export interface Client {
  execute(stmt: InStatement): Promise<ResultSet>;
  executeMultiple(sql: string): Promise<void>;
  batch(stmts: readonly InStatement[], mode?: TransactionMode): Promise<ResultSet[]>;
  migrate(stmts: readonly InStatement[]): Promise<ResultSet[]>;
  transaction(mode?: TransactionMode): Promise<Transaction>;
  close(): void;
  readonly closed: boolean;
}

export interface ClientConfig {
  /** 库文件路径。允许带 `file:` 前缀（老调用点的写法），会被剥掉。 */
  url: string;
  /** 忙等超时（毫秒）。默认 5s：预览播种会在 server 跑着的时候开第二条连接读主库。 */
  timeout?: number;
  readOnly?: boolean;
}

/**
 * `file:C:\Users\...` 在 Windows 上不是合法 URL（盘符冒号 + 反斜杠），而 `node:sqlite`
 * 本来就吃裸路径，所以这里统一剥掉前缀 —— 新代码直接传路径，老写法也不会炸。
 */
function toPath(url: string): string {
  if (url.startsWith("file://")) return decodeURIComponent(url.slice(7));
  if (url.startsWith("file:")) return url.slice(5);
  return url;
}

/**
 * `node:sqlite` 只认 null / number / bigint / string / TypedArray。libsql 还额外收
 * boolean 和 Date，仓库里有调用点在用，所以在这一层按 SQLite 的老规矩折算掉：
 * boolean → 0/1（drizzle 的 integer boolean 列本来就是这么存的），Date → ISO 字符串
 * （schema 里的时间列都是 TEXT）。undefined 当 null，跟 libsql 一致。
 */
function toBindable(v: InValue): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

function namedArgs(args: InArgs | undefined): Record<string, SQLInputValue> | null {
  if (!args || Array.isArray(args)) return null;
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(args)) out[k] = toBindable(v);
  return out;
}

function positionalArgs(args: InArgs | undefined): SQLInputValue[] {
  return Array.isArray(args) ? args.map(toBindable) : [];
}

function buildRow(names: readonly string[], values: readonly unknown[]): Row {
  const row: Record<string | number, unknown> = {};
  for (let i = 0; i < values.length; i++) {
    Object.defineProperty(row, i, { value: values[i], enumerable: false, configurable: true, writable: true });
  }
  Object.defineProperty(row, "length", { value: values.length, enumerable: false, configurable: true, writable: true });
  // 具名列最后贴：重名列（join 出两个 `id`）按 libsql 的老规矩后来居上，位置读法仍完整。
  for (let i = 0; i < names.length; i++) {
    Object.defineProperty(row, names[i]!, { value: values[i], enumerable: true, configurable: true, writable: true });
  }
  return row as unknown as Row;
}

/** 预处理语句缓存上限。热路径（drizzle 生成的那些）反复命中，DDL 一次性语句不占位。 */
const STMT_CACHE_MAX = 512;
const CACHEABLE = /^\s*(?:select|insert|update|delete|with)\b/i;

class NodeSqliteClient implements Client {
  private db: Db;
  private cache = new Map<string, StatementSync>();
  closed = false;

  constructor(config: ClientConfig) {
    this.db = new DatabaseSync(toPath(config.url), {
      // 外键约束默认开，跟 libsql 一致，别在迁移期悄悄改语义。
      enableForeignKeyConstraints: true,
      timeout: config.timeout ?? 5000,
      readOnly: config.readOnly ?? false,
    });
  }

  private prepare(sql: string): StatementSync {
    const hit = this.cache.get(sql);
    if (hit) return hit;
    const stmt = this.db.prepare(sql);
    // 一律拿数组：重名列只有位置读法是对的（见文件头）。
    stmt.setReturnArrays(true);
    if (CACHEABLE.test(sql)) {
      // 撑满就整体丢掉重来：这里要的是「热语句常驻」，不是精确的 LRU。
      if (this.cache.size >= STMT_CACHE_MAX) this.cache.clear();
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /** 同步内核。对外一律包成 Promise（libsql 的接口是异步的，drizzle 按异步用）。 */
  private runSync(stmt: InStatement): ResultSet {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? undefined : stmt.args;
    const prepared = this.prepare(sql);
    const named = namedArgs(args);
    const positional = positionalArgs(args);
    // 每次都重新问列名：DDL 改过表之后 SQLite 会自动重编译语句，列可能变。
    const names = prepared.columns().map((c) => c.name);
    if (!names.length) {
      // 不出行的语句（INSERT/UPDATE/DELETE/DDL）：run() 才给得到 changes/rowid。
      const changed = named ? prepared.run(named) : prepared.run(...positional);
      return {
        rows: [],
        columns: [],
        rowsAffected: Number(changed.changes),
        lastInsertRowid: BigInt(changed.lastInsertRowid),
      };
    }
    // setReturnArrays 之后 all() 实际返回的是值数组，类型签名还写着对象，只能在这里断言一次。
    const raw = (named ? prepared.all(named) : prepared.all(...positional)) as unknown as unknown[][];
    return {
      rows: raw.map((values) => buildRow(names, values)),
      columns: names,
      // 出行的语句（含 `… RETURNING`）不报 rowsAffected：SQLite 的 changes() 在 SELECT
      // 之后是上一条写语句的陈旧值，宁可给 0 也不给一个看着像真的假数。调用点数
      // RETURNING 的行数一律用 `rows.length`。
      rowsAffected: 0,
      lastInsertRowid: undefined,
    };
  }

  async execute(stmt: InStatement): Promise<ResultSet> {
    return this.runSync(stmt);
  }

  async executeMultiple(sql: string): Promise<void> {
    this.cache.clear(); // 这条路上跑的是整块 DDL，缓存里的旧语句没必要留
    this.db.exec(sql);
  }

  async transaction(mode: TransactionMode = "write"): Promise<Transaction> {
    // write 用 IMMEDIATE：一上来就拿写锁，避免读事务中途升级撞上 SQLITE_BUSY。
    this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
    let done = false;
    return {
      execute: async (stmt: InStatement): Promise<ResultSet> => {
        if (done) throw new Error("事务已经结束了，不能再执行语句");
        return this.runSync(stmt);
      },
      commit: async (): Promise<void> => {
        if (done) return;
        done = true;
        this.db.exec("COMMIT");
      },
      rollback: async (): Promise<void> => {
        if (done) return;
        done = true;
        this.db.exec("ROLLBACK");
      },
      close: (): void => {
        if (done) return;
        done = true;
        try { this.db.exec("ROLLBACK"); } catch { /* 已经不在事务里了 */ }
      },
    };
  }

  async batch(stmts: readonly InStatement[], mode: TransactionMode = "deferred"): Promise<ResultSet[]> {
    if (!stmts.length) return [];
    // 已经在事务里（drizzle 的 db.transaction 内部再 batch）就别嵌套 BEGIN，直接跑。
    if (this.db.isTransaction) return stmts.map((s) => this.runSync(s));
    const tx = await this.transaction(mode);
    try {
      const out = stmts.map((s) => this.runSync(s));
      await tx.commit();
      return out;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  /** drizzle 的 migrator 走这条；本仓库用 `drizzle-kit push`，留着只为接口完整。 */
  async migrate(stmts: readonly InStatement[]): Promise<ResultSet[]> {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      return await this.batch(stmts, "deferred");
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.db.close();
  }
}

export function createClient(config: ClientConfig): Client {
  return new NodeSqliteClient(config);
}
