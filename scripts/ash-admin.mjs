#!/usr/bin/env node
// 宿主机逃生门(docs/multi-user-plan.md §三)。
//
// 场景:多人模式下唯一的管理员把 key 弄丢了,而重置 key 这件事本身要管理员权限 ——
// 从 HTTP 那一侧看是个死结。出路是**能碰到数据库文件的人**:他本来就拥有这台机器上的
// 一切(可以直接改库、可以读所有仓库),所以给他一条正门不削弱任何东西,只是省掉手写
// SQL 时把 scrypt 参数记错的风险。
//
// 用法(在跑着 ash 的那台机器上、仓库根目录):
//   node scripts/ash-admin.mjs status          # 当前模式、用户名单
//   node scripts/ash-admin.mjs invite-admin    # 给第一个管理员发一条新的领取链接
//   node scripts/ash-admin.mjs invite <姓名>   # 给指定用户发链接(重置他的 key)
//
// **不需要停 ash**:它只写 users / user_invites 两张表,ash 每次请求都现读。
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DB_FILE = process.env.ASH_DB
  ? resolve(process.env.ASH_DB)
  : fileURLToPath(new URL("../data/ash.db", import.meta.url));

if (!existsSync(DB_FILE)) {
  console.error(`找不到数据库:${DB_FILE}`);
  console.error("请在跑着 ash 的那台机器上、仓库根目录执行;或用 ASH_DB=<路径> 指定。");
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => all(sql, ...args).at(0) ?? null;
const run = (sql, ...args) => db.prepare(sql).run(...args);

function tableExists(name) {
  return !!one("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
}

function instanceMode() {
  if (!tableExists("app_settings")) return "";
  const row = one("SELECT value FROM app_settings WHERE key='instanceMode'");
  if (!row?.value) return "";
  // app_settings 存的是 **JSON**(server/src/app-settings.ts 写入时 JSON.stringify),
  // 所以库里躺着的是 `"multi"` 带引号那六个字节,不是裸 multi。直接比字符串会让这条
  // 逃生门在真库上永远判成「不是多人模式」——而它存在的全部意义就是真库出事时能用。
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    // 手工改过库的情况:裸字符串也认,别让人卡在引号上。
    return row.value;
  }
}

function requireMulti() {
  const mode = instanceMode();
  if (mode !== "multi") {
    console.error(`这个实例不是多人模式(当前:${mode || "还没设定"}),没有用户可管。`);
    process.exit(1);
  }
  if (!tableExists("users")) {
    console.error("库里还没有 users 表 —— 先启动一次 ash 让它建表。");
    process.exit(1);
  }
}

// 与 server/src/auth/store.ts 的 tokenDigest 必须逐字节一致:链接里的明文 token 只在
// 打印那一刻存在,库里存的是它的 sha256。
const tokenDigest = (token) => createHash("sha256").update(token).digest("hex");
const mintToken = () => randomBytes(32).toString("base64url");
const nowIso = () => new Date().toISOString();
const INVITE_DAYS = 7;

function issueInvite(user) {
  const token = mintToken();
  // 列名与 server/src/db/schema.ts 的 user_invites 必须对上:是 consumed_at(领取)
  // 与 revoked_at(作废)两列,不是单一的 used_at。写错列名的后果是 `no such column`
  // 当场炸掉 —— 而这条命令的使用场景恰恰是「唯一的管理员进不去了」,那时没有第二条路。
  // 作废这个人手上的旧链接:同时飘着两条会让「我到底该点哪个」变成一次支持请求。
  run(
    "UPDATE user_invites SET revoked_at = ? WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
    nowIso(),
    user.id,
  );
  run(
    "INSERT INTO user_invites (id, user_id, token_hash, created_by, created_at, expires_at, consumed_at, revoked_at) VALUES (?,?,?,?,?,?,NULL,NULL)",
    randomBytes(12).toString("hex"),
    user.id,
    tokenDigest(token),
    null,
    nowIso(),
    new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString(),
  );
  // 领取链接会**重新生成 key**,所以顺手把旧 key 与所有会话作废 —— 「我丢了 key」的
  // 正确语义就是「他手上那把从现在起打不开门」。
  run("UPDATE users SET key_hash = NULL, status = 'invited' WHERE id = ?", user.id);
  if (tableExists("user_sessions")) run("DELETE FROM user_sessions WHERE user_id = ?", user.id);
  return token;
}

function printInvite(user, token) {
  const port = process.env.PORT ?? "4317";
  console.log("");
  console.log(`已为「${user.name}」生成新的领取链接(${INVITE_DAYS} 天内有效):`);
  console.log("");
  console.log(`  http://localhost:${port}/claim/${token}`);
  console.log("");
  console.log("在浏览器里打开它,会当场生成一把新 key 并登录。");
  console.log("注意:这条命令已经把该账号的旧 key 和所有登录会话作废了。");
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "status": {
    console.log(`数据库:${DB_FILE}`);
    console.log(`实例模式:${instanceMode() || "还没设定(首次启动会弹向导)"}`);
    if (instanceMode() === "multi" && tableExists("users")) {
      const rows = all("SELECT name, role, status, dir_name, key_hash FROM users ORDER BY created_at");
      console.log(`用户 ${rows.length} 人:`);
      for (const r of rows) {
        const key = r.key_hash ? "已领 key" : "尚未领 key";
        console.log(`  - ${r.name}(${r.role === "admin" ? "管理员" : "成员"}/${r.status}/${key})目录 ${r.dir_name}`);
      }
    }
    break;
  }
  case "invite-admin": {
    requireMulti();
    // 优先挑还能用的管理员;一个都没有(全被停用)时顺手把最早那个恢复成 active ——
    // 否则这条逃生门自己就被 status 挡住了。
    const admin =
      one("SELECT * FROM users WHERE role='admin' AND status != 'suspended' ORDER BY created_at LIMIT 1") ??
      one("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1");
    if (!admin) {
      console.error("库里一个管理员都没有。用 `invite <姓名>` 指定一个已有用户,或直接重跑首启向导。");
      process.exit(1);
    }
    printInvite(admin, issueInvite(admin));
    break;
  }
  case "invite": {
    requireMulti();
    const name = rest.join(" ").trim();
    if (!name) {
      console.error("用法:node scripts/ash-admin.mjs invite <姓名>");
      process.exit(1);
    }
    const user = one("SELECT * FROM users WHERE name = ?", name);
    if (!user) {
      console.error(`没有叫「${name}」的用户。用 \`status\` 看名单。`);
      process.exit(1);
    }
    if (user.status === "suspended") {
      run("UPDATE users SET status='invited' WHERE id = ?", user.id);
      console.log(`(顺带把「${name}」从停用状态放了出来)`);
    }
    printInvite(user, issueInvite(user));
    break;
  }
  case "promote": {
    requireMulti();
    const name = rest.join(" ").trim();
    const user = name ? one("SELECT * FROM users WHERE name = ?", name) : null;
    if (!user) {
      console.error("用法:node scripts/ash-admin.mjs promote <姓名>");
      process.exit(1);
    }
    run("UPDATE users SET role='admin' WHERE id = ?", user.id);
    console.log(`「${user.name}」已提升为实例管理员。`);
    break;
  }
  default:
    console.log("ash 宿主机管理工具(多人模式的逃生门)");
    console.log("");
    console.log("  node scripts/ash-admin.mjs status          查看模式与用户名单");
    console.log("  node scripts/ash-admin.mjs invite-admin    给第一个管理员发新的领取链接");
    console.log("  node scripts/ash-admin.mjs invite <姓名>   给指定用户发领取链接(作废其旧 key)");
    console.log("  node scripts/ash-admin.mjs promote <姓名>  把某人提升为实例管理员");
    console.log("");
    console.log("这些命令直接操作数据库文件,不需要停掉 ash。");
    process.exit(command ? 1 : 0);
}

db.close();
