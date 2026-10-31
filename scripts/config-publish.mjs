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
import { randomBytes } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** 临时副本一出生就只有自己能读 —— 它装着用户配置的全文。 */
export const TMP_MODE = 0o600;

const foreignChange = (file) =>
  `${file} 在这期间被别的程序改过，所以这次没有写（免得盖掉那次改动）`;

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

/** 预演产物的名字前缀。后面还要接一段随机值 —— 见 `rehearse` 的「独占创建」。 */
const PROBE_PREFIX = ".ash-publish-probe-";

/**
 * **动用户那份之前,先证明这份正文落得下去**:在同目录(同一个文件系统、同一份配额)写一个
 * 临时文件、fsync 到设备、再删掉。落不下去就返回那个异常,活动配置**一个字节都没碰过**。
 *
 * 为什么非要这一步(审查 R1,注入持续 EIO 实测):就地写是先截断再写,没有原子性。上一版
 * 把「写出异常就回写旧正文」当成失败安全 —— 可写失败往往不是一次性的(配额耗尽、设备 EIO、
 * 挂载转成只读),那时**回写同样失败**,盘上留下的就是半截正文(`{"userSetting":"ke`),备份
 * 完整而活动那份废了,而 CLI 读的是活动那份。预演把这一整类挡在动手之前。
 *
 * 挡不住的有两档,文档和失败话术里都不许瞒着:① 写到一半断电 / 进程被杀;② **只有目标那个
 * inode 坏**的持续故障(同目录预演过得去、真写一直 EIO)。两档都靠 `.bak-ash-setup` 还原。
 *
 * **探针一律独占创建**(本轮审查 F1,实测:上一版那个固定名字被指向一个无关文件时,预演把
 * 用户那份正文整份覆盖进去、随后还把它删了)。三条一起才算数:
 *  · 名字带随机段,而且用 `wx` 打开 —— 路径上此刻有任何东西(普通文件、软链接、目录)都直接
 *    EEXIST,我们绝不会写到别人的对象上;
 *  · 写和 fsync 都走**自己这个句柄**,不按路径二次打开(中途被人换掉也影响不到这一步);
 *  · 只删**自己刚建出来的那一个**,不是 force 清扫一个固定名字。
 */
function rehearse(target, body, write, create) {
  // 新建那一路:父目录得先有(好几家 CLI 的配置在子层)。顺序跟真写那一步一致 ——
  // 建目录本身也是一次写,挡不住的话这一步就该失败。
  if (create) {
    try { mkdirSync(dirname(target), { recursive: true }); } catch (error) { return error; }
  }
  let probe = "";
  let fd = null;
  for (let left = 4; left > 0; left--) {
    probe = `${target}${PROBE_PREFIX}${randomBytes(9).toString("hex")}`;
    // 一出生就只有自己能读:它装着用户配置的全文。
    try { fd = openSync(probe, "wx", TMP_MODE); break; } catch (error) {
      if (error.code !== "EEXIST" || left === 1) return error;
    }
  }
  try {
    write(fd, body, "utf8");
    fsyncSync(fd);
    return null;
  } catch (error) {
    return error;
  } finally {
    try { closeSync(fd); } catch { /* 已经关了也不该拦住结论 */ }
    try { rmSync(probe, { force: true }); } catch { /* 自己的产物,删不掉也不该拦住结论 */ }
  }
}

/**
 * 一次发布:**预演 → 备份 → 再确认一次没被别人改过 → 就地写 → 读回来比对**。
 *
 * 顺序是本轮审查 F3 打出来的:**最后一次新鲜度校验必须紧贴写盘那一步**。上一版把校验放在
 * 最前面,后面还夹着预演(写一份全文 + fsync)和备份(整份 copy)—— 这两步在慢盘、网络盘、
 * 大配置上是秒级的,而它们对外部编辑没有任何互斥作用。那段窗口里用户存了一版新配置,上一版
 * 照旧拿旧快照盖下去,甚至会先把**刚存的那一版**备份掉、再把旧的写回活动路径,读回来比对还
 * 匹配、于是报成功。现在慢步骤全排在最终校验之前,校验没过就整条收手。
 *
 * 剩下的缝只有「最终那一读 → 写」之间的亚毫秒级(没有锁能关掉它 —— CLI 自己写这份文件时
 * 不会来拿我们的锁),跟上面那段秒级窗口不是一个量级。
 *
 * @param previous 这一轮**读到过**的那一版全文(`readForWrite().text`);null = 当时确认没有
 *                 这个文件。不是「可能是什么」,是「确实读到了什么」。
 * @returns `{ ok: true, backup }` | `{ ok: false, why, stale? }` —— `ok:false` 一律表示
 *          **一个字节都没写**(除了「写一半又回写成功」那种,那时 `why` 会说清);
 *          `stale:true` = 盘上那份在这期间被别的程序改过。
 */
export function publishConfirmed({ file, previous, body, backupSuffix = ".bak-ash-setup", write }) {
  const first = readForWrite(file);
  if (!first) return { ok: false, why: `${file} 读不出来了，这次什么都没写` };
  // 早一道:已经被改过就别白做后面那些慢活(真正作数的是写盘前那一道)。
  if (first.text !== previous) return { ok: false, stale: true, why: foreignChange(file) };
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
  // 只删得掉**自己这一轮建出来的**那一份:上一次成功发布留下的备份不许动(那是用户手里
  // 唯一的旧版本)。
  const backupExisted = backup !== null && existsSync(backup);
  if (backup) copyFileSync(file, backup);
  // 拷完立刻读回来核对:拷贝本身也会半途失败(同一类设备故障),一份半截的备份比没有更坏。
  // 核不上有两种来历,分清了再说话:**活动那份在这期间被改过**(拷到的就是新那版),还是
  // 拷贝自己出了问题。前者是 F3 那条新鲜度失败,后者才是「备份没留成」。
  if (backup) {
    const back = readForWrite(backup);
    if (!back || back.text !== previous) {
      if (!backupExisted) { try { rmSync(backup, { force: true }); } catch { /* 尽力 */ } }
      const live = readForWrite(file);
      if (live && live.text !== previous) return { ok: false, stale: true, why: foreignChange(file) };
      return { ok: false, why: `给 ${file} 留备份没留成（${backup} 读回来跟原文不一样），所以这次什么都没写` };
    }
  }
  // **写盘前最后一步:再确认一次盘上还是我们读到的那一版**(F3)。没过就收手,顺手把刚才
  // 建出来的那份备份删掉 —— 什么都没改却留一份 `.bak`,用户会以为我们动过手。
  const now = readForWrite(file);
  if (!now || now.text !== previous) {
    if (backup && !backupExisted) { try { rmSync(backup, { force: true }); } catch { /* 尽力 */ } }
    return now
      ? { ok: false, stale: true, why: foreignChange(file) }
      : { ok: false, why: `要写 ${file} 之前又读不出它了，这次什么都没写` };
  }
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
          : `而且回写也没成功，活动那份现在是坏的 —— 请把 ${backup ?? "备份"} 拷回去手工还原`),
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
