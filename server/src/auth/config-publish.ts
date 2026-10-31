// 一份用户配置文件的**发布事务**:读 → 拼 → 批准 → 替换,而且只替换我们读到的那一版。
//
// 为什么单独一个文件:这套规矩全是前后五轮审查在真机上打出来的(就地写保住 DACL / 扩展 ACL /
// 硬链接 / 软链接目标、失败回写、写完读回来比对、STALE 重做),而 ash 现在要往**十五家 CLI**
// 的配置里补 ash MCP 登记。一家一份「读改写」就是十五处可以漏掉其中一条的地方 —— 所以
// 格式各族只管拼内容(`mcp-registry/shapes.ts`,纯函数),碰文件的只有这一个文件。
//
// 注:`scripts/` 下的安装器另有一份同规矩的实现(setup 在裸 Node 上跑,导不进 TS),两边
// 只能靠「同一条规矩写两遍」,回归测试钉着两边行为一致。
import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** 「没有这个文件」/「有但读不动」/「读得动」。判 absent 之前必须先过这一关（N1）。 */
export function fileState(file: string): "missing" | "readable" | "unreadable" {
  try {
    readFileSync(file);
    return "readable";
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? "missing" : "unreadable";
  }
}


/**
 * 一次**成功**的读:`text === null` = 确认没有这个文件(ENOENT)。读不动(权限、IO、是个目录)
 * 返回 null —— 那不是「空」,拿它当空去写,就是一份只剩 MCP 登记的新文件把用户的整份配置
 * 盖掉,界面还报「已接好」(新链第 5 轮审查第 1 条:claude 那半边就是这么丢的)。
 */
export type ConfirmedRead = { readonly file: string; readonly text: string | null; readonly __confirmed: true };

export function readForWrite(file: string): ConfirmedRead | null {
  try {
    return { file, text: readFileSync(file, "utf8"), __confirmed: true };
  } catch (e) {
    return (e as { code?: string }).code === "ENOENT" ? { file, text: null, __confirmed: true } : null;
  }
}


/** 沙盘副本一出生就只有自己能读 —— 它装着用户配置的全文(沙盘目录本身是 0700,这是第二道)。 */
export const TMP_MODE = 0o600;


/** 跟到软链的尽头(最多 8 层,防环);最终悬空就用它指的那个路径,别去改中间那条链接。 */
function resolveTarget(file: string): string {
  let p = file;
  for (let left = 8; left > 0; left--) {
    try { return realpathSync(p); } catch { /* 不存在,或者这条链悬空 */ }
    let next: string;
    try { next = readlinkSync(p); } catch { return p; } // 不是软链 ⇒ 要写的就是它
    p = resolve(dirname(p), next);
  }
  // 跟满 8 层还没到头:成环,或者长到不正常。此刻 `p` 只是链条中间的一环,**写它就是把一条
  // 软链接换成普通文件**(第 5 轮 N9:上一版直接 `return p`)。定位不了就不写,如实报。
  throw new Error(`${file} 的软链接跟了 8 层还没到头，没法确定该写哪个文件`);
}


/**
 * 把批准过的内容写到 `read.file`,**保住这个文件的身份** —— 它的有效访问边界、它的链接关系。
 * 只收 `readForWrite` 的结果:「写之前必须拿到一次成功的读」由类型钉住,不靠各分支自己记。
 *
 * 这是安装器那份发布器(`scripts/codex-mcp.mjs` 的 `publishInPlace`)的同一套规矩,两边各
 * 一份实现是因为 setup 在裸 Node 上跑、导不进 TS。规矩本体全是审查打出来的:
 *
 * **一律就地写。** 原来 POSIX 走「同目录临时副本 + rename」,那样换上去的是一个**新文件**,
 * 它只继承得到我们抄得过去的那几位,而这份文件里装着 key:
 * ① Windows 的 DACL 抄不了(Node 没有读写 ACL 的接口),原文件单独收紧过的访问边界当场消失
 *    —— 第 4 轮 F1 在真机上实测到 Everyone 读进了 DACL。
 * ② POSIX 的扩展 ACL 同样抄不了,**mode 相等不等于有效权限相等**:第 5 轮 F1 实测 macOS 上
 *    `chmod +a 'user:nobody deny read'` 这条禁读会随 rename 消失(`-rw-r--r--+` 变回
 *    `-rw-r--r--`,mode 一模一样)。本机另测了 `copyFileSync`,它也不带这条 ACL 过去;带得
 *    过去的只有 `cp -p`/`ditto` 这类外部命令,而**这个文件里不许起子进程**(第 4 轮 F2 之后
 *    有结构断言钉着,见 `test-user-cli-mcp.ts` 第 ㉓ 组)。
 * ③ 硬链接会被换掉 inode,断开用户显式接起来的关联。
 * ④ 软链写它指向的那份(第 3 轮 F2),否则一写就把链接本身变成普通文件。
 *
 * 代价是**失去原子替换**:截断到写完之间有个窗口,这期间 CLI 读到的是空的或者半截的
 * (第 4/5 轮 N8,现在全平台都如此;这份 `.claude.json` 还是 CLI 自己也在写的文件)。所以
 * **恢复手段必须是明确的**:写出异常就把这一轮读到的那一版原样写回去(原来没有这个文件就
 * 把它删掉),而且**动手之前先留一份核对过的备份**(见 `backupBefore`)。
 *
 * 回写也失败时盘上就是半截。那不只是「断电/被杀」那一档 —— 本轮审查在裸 Node 那侧实测过
 * **只有目标那个 inode 持续坏**的情形:同目录预演过得去,写活动文件一直 EIO,回写同样 EIO,
 * 活动配置留成 `{"other":{"`。所以这一档必须靠备份,不能靠「下一次起跑接住」:下一次起跑能
 * 接住的只有「读得通但没有 ash ⇒ 重新补一份」和「读不通 ⇒ 不猜、如实报给用户」。
 *
 * 所有者(uid/gid)没抄:配置在谁的目录里就该由谁这个进程写。
 */
/** 预演产物的名字前缀。后面还要接一段随机值 —— 见 `rehearse` 的「独占创建」。 */
const PROBE_PREFIX = ".ash-publish-probe-";

/**
 * **动用户那份之前,先证明这份正文落得下去**:在同目录(同一个文件系统、同一份配额)写一个
 * 只有自己能读的临时文件、fsync 到设备、再删掉。落不下去就交回那句话,活动配置一个字节没碰。
 *
 * 为什么非要这一步(审查 R1):就地写是先截断再写,没有原子性,而上一版把「写出异常就回写
 * 旧正文」当成了失败安全。可写失败往往不是一次性的(配额耗尽、设备 EIO、挂载转只读),那时
 * **回写同样失败**,盘上留下半截正文、备份完整,而 CLI 读的是活动那份。预演把这一整类挡在
 * 动手之前。挡不住的有两档,话术里不许瞒着:① 写到一半断电/被杀;② **只有目标那个 inode 坏**
 * 的持续故障(同目录预演过得去、真写一直 EIO)。两档都靠 `commit` 留下的备份还原。
 *
 * **探针一律独占创建**(本轮审查 F1,裸 Node 那侧实测:上一版那个固定名字被指向一个无关文件
 * 时,预演把用户那份正文整份覆盖进去、随后还把它删了)。三条一起才算数:
 *  · 名字带随机段,而且用 `wx` 打开 —— 路径上此刻有任何东西(普通文件、软链接、目录)都直接
 *    EEXIST,我们绝不会写到别人的对象上;
 *  · 写和 fsync 都走**自己这个句柄**,不按路径二次打开;
 *  · 只删**自己刚建出来的那一个**,不是 force 清扫一个固定名字。
 */
function rehearse(target: string, body: string, create: boolean): string | null {
  // 新建那一路:父目录得先有(gemini 的 `.gemini/`、kiro 的 `settings/` 这种子层)。
  // 顺序跟真写那一步一致 —— 建目录本身也是一次写,挡不住的话这一步就该失败。
  if (create) {
    try { mkdirSync(dirname(target), { recursive: true }); } catch (e) { return (e as Error).message; }
  }
  let probe = "";
  let fd: number | null = null;
  for (let left = 4; left > 0; left--) {
    probe = `${target}${PROBE_PREFIX}${randomBytes(9).toString("hex")}`;
    try { fd = openSync(probe, "wx", TMP_MODE); break; } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST" || left === 1) return (e as Error).message;
    }
  }
  try {
    writeFileSync(fd!, body, "utf8");
    fsyncSync(fd!);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    try { closeSync(fd!); } catch { /* 已经关了也不该拦住结论 */ }
    try { rmSync(probe, { force: true }); } catch { /* 自己的产物,删不掉也不该拦住结论 */ }
  }
}


/** 备份文件的后缀。跟安装器那份同名:同一个用途,用户只需要记住一个名字。 */
export const BACKUP_SUFFIX = ".bak-ash-setup";

/**
 * **改写已有文件之前,先留一份核对过的备份**(上一轮审查 F2 的可修部分)。
 *
 * 为什么非留不可:就地写没有原子替换,而「写出异常就回写旧正文」这条退路在**只有目标那个
 * inode 坏**的持续故障下同样失败 —— 审查在裸 Node 那侧实测过:活动配置留成 `{"other":{"`,
 * 而这条路**一份备份都没有**,用户手里什么都不剩。安装器那侧一直有 `.bak-ash-setup`,服务端
 * 这条(每次起跑、每次读设置页都会走)原来没有。
 *
 * **备份也是发布产物,所以同样独占创建**(本轮审查 F2):上一版拿 `copyFileSync` 往那个固定
 * 名字上直接拷,于是那个名字上要是摆着一条指向用户别的文件的软链接,这一拷就把那份无关文件
 * 改成了整份 CLI 配置 —— 还显示成功。三条跟预演同一套(见 `rehearse`):
 *  · 用 `wx` 开 —— 路径上此刻有任何东西(普通文件、软链接、目录)都直接 EEXIST;
 *  · 固定名字被占住(含**上一次成功发布留下的那份备份**)就换一个带随机段的名字,绝不覆盖、
 *    绝不跟随别人的对象;
 *  · 正文走**自己这个句柄**写、fsync 到设备,不按路径二次打开。
 *
 * 代价如实写明:备份一律 0600 出生(拷权限这件事本来就只在 POSIX 上成立),而且同一份配置
 * 反复被改写时会留下好几份 `…-<随机段>`。两样都比「可能写到用户别的文件上」便宜。
 *
 * **核对**的意思是:写完立刻读回来逐字节比对。写备份本身也可能半途失败(同一类设备故障),
 * 一份半截的备份比没有备份更坏 —— 那种情况下直接收手,活动配置一个字节都不碰。
 *
 * 返回 `{ backup }` = 留好了;`{ why }` = 没留成,这次别写;`{ backup: null }` = 原来没有
 * 这个文件,没什么可备份的。`created` 恒为真(留下来的那份一定是我们自己建的)—— 收手时
 * 只删自己建的那一份,**上一次成功发布留下的备份不许动**(那是用户手里唯一的旧版本)。
 */
function backupBefore(read: ConfirmedRead): { backup: string | null; created: boolean } | { why: string } {
  if (read.text === null) return { backup: null, created: false };
  const nope = (why: string) => ({ why: `给 ${read.file} 留备份没留成（${why}），所以这次什么都没写` });
  const plain = `${read.file}${BACKUP_SUFFIX}`;
  let backup = plain;
  let fd: number | null = null;
  for (let left = 4; left > 0; left--) {
    try { fd = openSync(backup, "wx", TMP_MODE); break; } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST" || left === 1) return nope((e as Error).message);
      backup = `${plain}-${randomBytes(6).toString("hex")}`;
    }
  }
  let failed: string | null = null;
  try {
    writeFileSync(fd!, read.text, "utf8");
    fsyncSync(fd!);
  } catch (e) {
    failed = (e as Error).message;
  }
  try { closeSync(fd!); } catch { /* 已经关了也不该拦住结论 */ }
  if (failed === null) {
    const back = readForWrite(backup);
    if (!back || back.text !== read.text) failed = `${backup} 读回来跟原文不一样`;
  }
  if (failed !== null) {
    // 删的是**自己刚建出来的那一个**(名字就在手上),不是 force 清扫一个固定名字。
    try { rmSync(backup, { force: true }); } catch { /* 自己的产物,删不掉也不该拦住结论 */ }
    return nope(failed);
  }
  return { backup, created: true };
}

function publishInPlace(read: ConfirmedRead, body: string): void {
  const target = resolveTarget(read.file);
  try {
    // 新建的那一档要先有父目录:好几家 CLI 的配置在子层(gemini 的 `.gemini/settings.json`、
    // kiro 的 `settings/mcp.json`),目录不存在时 `writeFileSync` 直接 ENOENT。
    // **只在原来确实没有这个文件时建** —— 已有文件的父目录当然在,那时多调一次就是多一次
    // 对用户目录的写操作。
    if (read.text === null) {
      mkdirSync(dirname(target), { recursive: true });
      // **新建的那一份只给自己读**(0600),跟裸 Node 那份逐字节同口径:它装着 MCP 接法。
      // 已有文件走下面那句、权限一个位都不动(就地写的全部意义就在这儿)。
      writeFileSync(target, body, { encoding: "utf8", mode: TMP_MODE });
    } else {
      writeFileSync(target, body, "utf8");
    }
  } catch (e) {
    try {
      if (read.text === null) rmSync(target, { force: true });
      else writeFileSync(target, read.text, "utf8");
    } catch { /* 尽力:连回写都失败就只能让下一次起跑接住了 */ }
    throw e;
  }
}


/**
 * 一次补接事务:**读 → 拼 → 批准 → 替换**,而且**只替换我们读到的那一版**。
 *
 * 两条规矩是前后两轮审查打出来的:
 *
 * ① **先批准再替换**(上一轮 F1)。原来是「写进去 → 读回来 → 验不过再还原」:验的那一问
 *    本身可能答不出来(超时、起不来、输出看不懂),上一版把这些当成「可以留着」,于是盘上
 *    留下一份 codex 整份拒载的配置、界面还写着已接好;而「还原」本身是第二次写,写完到
 *    还原之间崩一次,坏文件就留在那儿了。
 *
 * ② **替换之前确认盘上还是这一轮读到的那一版**(本轮 F1)。倒过来之后还剩一个窗口:批准
 *    那一问要起一次 codex、秒级,这期间用户在另一处存了新模型、加了自己的 MCP —— 上一版
 *    拿批准过的**旧快照**盖下去,那些改动当场消失,函数照样答「已接好」(审查实测:
 *    `model` 回退、`[mcp_servers.user_added]` 不见了)。所以盘上内容一变就整条重做:
 *    重新读、在**新内容**上重新拼、重新批准。拼出来的东西因此天然带上别人那次改动。
 *
 * 残留的窗口如实写明:`commit` 是「现读一次 → 比对 → 写」,两步之间还有亚毫秒级的缝。
 * 要彻底关掉它得给这份文件上文件锁,而 CLI 自己写它时不会拿那把锁,所以锁住的只有我们
 * 自己这几条路 —— 秒级的那个窗口是真问题,这个缝不是。
 */
export async function publishFresh<T>(
  file: string,
  round: (read: ConfirmedRead, commit: Commit) => Promise<T>,
  fail: (why: string) => T,
): Promise<T> {
  for (let left = PUBLISH_TRIES; left > 0; left--) {
    const read = readForWrite(file);
    if (!read) return fail(`${file} 读不出来，没有自动补写 —— 修好它的权限(或挪开它)再重启`);
    try {
      return await round(read, commit);
    } catch (e) {
      if (e !== STALE) throw e;
      if (left === 1) {
        return fail(`补接期间 ${file} 一直有别的程序在改（试了 ${PUBLISH_TRIES} 次都没赶上），这次什么都没写`);
      }
    }
  }
  /* c8 ignore next */
  return fail(`${file} 的补接没能落定`);
}


/** 这一轮读到的那一版已经不在盘上了 —— 由 `publishFresh` 接住,整条重做。 */
const STALE = Symbol("ash-mcp-config-moved");

/** 一份配置最多重做几遍。每遍都要起一次 codex,所以不能多;老是撞上就如实说没写。 */
const PUBLISH_TRIES = 3;

/** 把批准过的内容落盘。返回 null = 落定了;返回一句话 = 哪里不对。 */
export type Commit = (read: ConfirmedRead, body: string) => string | null;

const commit: Commit = (read, body) => {
  // 预演先行(R1):落不下去就在这里收手,用户那份还是原样。
  const dry = rehearse(resolveTarget(read.file), body, read.text === null);
  if (dry) return `写不进 ${read.file} 所在的目录（${dry}），所以这次什么都没写`;
  const saved = backupBefore(read);
  if ("why" in saved) {
    // 备份核不上有两种来历:**活动那份在这期间被改过**(拷到的就是新那版)⇒ 整条重做;
    // 拷贝自己出了问题 ⇒ 如实说没留成、这次不写。
    const live = readForWrite(read.file);
    if (live && live.text !== read.text) throw STALE;
    return saved.why;
  }
  // **写盘前最后一步:再确认一次盘上还是这一轮读到的那一版**(本轮审查 F3)。上一版把这一道
  // 放在最前面,后面还夹着预演(写一份全文 + fsync)和备份(整份 copy)—— 这两步在慢盘、
  // 网络盘、大配置上是秒级的,而它们对外部编辑没有任何互斥作用:那段窗口里用户存了一版新
  // 配置,上一版照旧拿旧快照盖下去,读回来比对还匹配、于是报成功。慢步骤全排在这一道之前。
  const now = readForWrite(read.file);
  if (!now) return dropBackup(saved, `要写 ${read.file} 之前又读不出它了`);
  // 别人动过 ⇒ 这一轮读到的那一版已经不作数,整条重做(见 publishFresh 的 ②)。
  if (now.text !== read.text) { dropBackup(saved, ""); throw STALE; }
  try {
    publishInPlace(read, body);
  } catch (e) {
    const restored = readForWrite(read.file);
    if (restored && restored.text === read.text) {
      return `写 ${read.file} 失败：${(e as Error).message}；原来那份已经原样放回去了`;
    }
    return `写 ${read.file} 失败：${(e as Error).message}；而且回写也没成功，活动那份现在是坏的 —— `
      + `请把 ${saved.backup ?? "备份"} 拷回去手工还原`;
  }
  const after = readForWrite(read.file);
  if (!after || after.text !== body) {
    return `写完 ${read.file} 读回来跟刚批准的那份不一样（有别的程序也在写它？），请手工检查一遍`;
  }
  return null;
};

/** 没写成就别留一份白备份:用户看见 `.bak-ash-setup` 会以为我们动过手。只删自己建的那份。 */
function dropBackup(saved: { backup: string | null; created: boolean }, why: string): string {
  if (saved.backup && saved.created) { try { rmSync(saved.backup, { force: true }); } catch { /* 尽力 */ } }
  return why;
}
