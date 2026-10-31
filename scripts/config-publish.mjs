// 安装器那一侧的**发布事务**:确认读到过 → 就地写 → 失败回写 → 写完读回来比对。
//
// 为什么这是一个单独的文件:setup 在裸 Node 上跑(`npm run setup` 时还没 build),导不进
// server 那份 `src/auth/config-publish.ts`。同一条规矩在这个仓库里只能有两份实现 —— 那就
// **只有两份**:codex 那条路(`codex-mcp.mjs`)和其余各家(`mcp-hosts.mjs`)共用这一个。
//
// 规矩本体和它的来历全在 server 那份的文件头里,这里不复述,只留必须当场看见的三条:
//
//  ① **一律就地写**:换成「临时文件 + rename」会丢掉 Windows DACL / POSIX 扩展 ACL,
//     断开硬链接,把软链接变成普通文件 —— 而这些文件里装着用户的 key。
//  ② **就地写没有原子性**,所以恢复手段必须是明确的:写出异常就把这一轮读到的那一版原样
//     写回去(原来没有这个文件就删掉它)。上一版把「已经留了 `.bak-ash-setup` 备份」当成
//     「失败安全」—— 审查注入一次 ENOSPC 就把用户整份配置留成了半截(`"{\n "userSetting": "k`),
//     备份完整但活动配置废了,而 CLI 读的是活动那份(本轮审查 R1)。
//  ③ **提交前先确认盘上还是这一轮读到的那一版**:拼内容、问 CLI 都要时间,这期间用户可能
//     刚存过新设置,拿旧快照盖下去就是把它抹掉。
import {
  closeSync, copyFileSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** 临时副本一出生就只有自己能读 —— 它装着用户配置的全文。 */
export const TMP_MODE = 0o600;

/**
 * 一次**成功**的读:`text === null` = 确认没有这个文件(ENOENT)。读不动(权限、IO、是个
 * 目录)返回 null —— 那不是「空」,拿它当空去写就是一份只剩 MCP 登记的新文件把用户整份配置
 * 盖掉,而安装日志还报「已注册」。
 */
export function readForWrite(file) {
  try {
    return { file, text: readFileSync(file, "utf8") };
  } catch (error) {
    return error.code === "ENOENT" ? { file, text: null } : null;
  }
}

/** 跟到软链的尽头(最多 8 层,防环);最终悬空就用它指的那个路径,别去改中间那条链接。 */
export function resolveTarget(file) {
  let p = file;
  for (let left = 8; left > 0; left--) {
    try { return realpathSync(p); } catch { /* 不存在,或者这条链悬空 */ }
    let next;
    try { next = readlinkSync(p); } catch { return p; } // 不是软链 ⇒ 要写的就是它
    p = resolve(dirname(p), next);
  }
  // 跟满 8 层还没到头:成环,或者长到不正常。此刻 `p` 只是链条中间的一环,**写它就是把一条
  // 软链接换成普通文件**。定位不了就不写,如实报。
  throw new Error(`${file} 的软链接跟了 8 层还没到头，没法确定该写哪个文件`);
}

/**
 * 就地写,写不出去就把 `previous` 原样放回去(原来没有这个文件就删掉它)。
 *
 * `write` 只为回归测试留:注入一次「写了一半就抛」才测得出 ② 那条不变量 —— 真·写满磁盘
 * 没法在测试里稳定复现,而这条不变量正是本轮审查实测打出来的。产品代码一律走默认值。
 */
export function publishInPlace(file, body, previous, write = writeFileSync) {
  const target = resolveTarget(file);
  try {
    if (previous === null) {
      mkdirSync(dirname(target), { recursive: true });
      // **新建的那一份只给自己读**:它装着 MCP 接法(kimi 原来的写入器就是 0600,改走这个
      // 通用发布器之后退成了 umask —— 本轮审查的非阻断项)。已有文件走下面那句、权限不动。
      write(target, body, { encoding: "utf8", mode: TMP_MODE });
    } else {
      write(target, body, "utf8");
    }
  } catch (error) {
    try {
      if (previous === null) rmSync(target, { force: true });
      else write(target, previous, "utf8");
    } catch { /* 尽力:连回写都失败就只剩那份 .bak-ash-setup 可以手工还原了 */ }
    throw error;
  }
}

/**
 * **动用户那份之前,先证明这份正文落得下去**:在同目录(同一个文件系统、同一份配额)写一个
 * 临时文件、fsync 到设备、再删掉。落不下去就返回那个异常,活动配置**一个字节都没碰过**。
 *
 * 为什么非要这一步(本轮审查 R1,注入持续 EIO 实测):就地写是先截断再写,没有原子性。上一版
 * 把「写出异常就回写旧正文」当成失败安全 —— 可写失败往往不是一次性的(配额耗尽、设备 EIO、
 * 挂载转成只读),那时**回写同样失败**,盘上留下的就是半截正文(`{"userSetting":"ke`),备份
 * 完整而活动那份废了,而 CLI 读的是活动那份。预演把这一整类挡在动手之前。
 *
 * 挡不住的只剩「写到一半断电/进程被杀」——那一档任何非原子写都兜不住,`.bak-ash-setup` 是
 * 唯一出路,所以文档里不许再承诺「中途失败不会留半截」。
 */
function rehearse(target, body, write, create) {
  const probe = `${target}.ash-publish-probe`;
  try {
    // 新建那一路:父目录得先有(好几家 CLI 的配置在子层)。顺序跟真写那一步一致 ——
    // 建目录本身也是一次写,挡不住的话这一步就该失败。
    if (create) mkdirSync(dirname(target), { recursive: true });
    // 临时副本装着用户配置全文,一出生就只有自己能读。
    write(probe, body, { encoding: "utf8", mode: TMP_MODE });
    const fd = openSync(probe, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return null;
  } catch (error) {
    return error;
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* 预演产物,删不掉也不该拦住结论 */ }
  }
}

/**
 * 一次发布:**确认没被别人改过 → 预演 → 备份 → 就地写 → 读回来比对**。
 *
 * @param previous 这一轮**读到过**的那一版全文(`readForWrite().text`);null = 当时确认没有
 *                 这个文件。不是「可能是什么」,是「确实读到了什么」。
 * @returns `{ ok: true, backup }` | `{ ok: false, why }` —— `ok:false` 一律表示**一个字节
 *          都没写**(除了 ② 那种写一半又回写成功的情况,那时 `why` 会说清)。
 */
export function publishConfirmed({ file, previous, body, backupSuffix = ".bak-ash-setup", write }) {
  const now = readForWrite(file);
  if (!now) return { ok: false, why: `${file} 读不出来了，这次什么都没写` };
  if (now.text !== previous) {
    return { ok: false, why: `${file} 在这期间被别的程序改过，所以这次没有写（免得盖掉那次改动）` };
  }
  // 预演先行:落不下去就在这里收手,用户那份还是原样。
  const target = resolveTarget(file);
  const dry = rehearse(target, body, write ?? writeFileSync, previous === null);
  if (dry) {
    return { ok: false, why: `写不进 ${file} 所在的目录（${dry.message}），所以这次什么都没写` };
  }
  const backup = previous !== null ? `${file}${backupSuffix}` : null;
  // 真要写了才备份:改的是用户自己的配置文件,出错要能一键还原。`copyFileSync` 在 POSIX 上
  // 带着原权限建目标(0600 的配置不会从备份这条路泄出去);Windows 的 DACL 它复制不了,那份
  // 备份仍继承父目录 —— 这个做法本任务开工前就是这样。
  if (backup) copyFileSync(file, backup);
  try {
    publishInPlace(file, body, previous, write);
  } catch (error) {
    const restored = readForWrite(file);
    const intact = restored && restored.text === previous;
    return {
      ok: false,
      why: `写 ${file} 失败：${error.message}；`
        + (intact
          ? "原来那份已经原样放回去了"
          : `而且回写也没成功 —— 请用 ${backup ?? "备份"} 手工还原`),
    };
  }
  const after = readForWrite(file);
  if (!after || after.text !== body) {
    return {
      ok: false,
      why: `写完 ${file} 读回来跟要写的那份不一样（有别的程序也在写它？），请手工检查一遍`,
    };
  }
  return { ok: true, backup };
}
