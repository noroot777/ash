// 一份用户配置文件的**发布事务**:读 → 拼 → 批准 → 替换,而且只替换我们读到的那一版。
//
// 为什么单独一个文件:这套规矩全是前后五轮审查在真机上打出来的(就地写保住 DACL / 扩展 ACL /
// 硬链接 / 软链接目标、失败回写、写完读回来比对、STALE 重做),而 ash 现在要往**十五家 CLI**
// 的配置里补 ash MCP 登记。一家一份「读改写」就是十五处可以漏掉其中一条的地方 —— 所以
// 格式各族只管拼内容(`mcp-registry/shapes.ts`,纯函数),碰文件的只有这一个文件。
//
// 注:`scripts/` 下的安装器另有一份同规矩的实现(setup 在裸 Node 上跑,导不进 TS),两边
// 只能靠「同一条规矩写两遍」,回归测试钉着两边行为一致。
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
 * 把它删掉)。回写也失败、或者断电/进程被杀来不及回写时,盘上会留下半截 —— 那一档这里兜不住,
 * 由下一次起跑接住:读得通但没有 ash ⇒ 重新补一份;读不通 ⇒ 不猜、如实报给用户。
 *
 * 所有者(uid/gid)没抄:配置在谁的目录里就该由谁这个进程写。
 */
/**
 * **动用户那份之前,先证明这份正文落得下去**:在同目录(同一个文件系统、同一份配额)写一个
 * 只有自己能读的临时文件、fsync 到设备、再删掉。落不下去就交回那句话,活动配置一个字节没碰。
 *
 * 为什么非要这一步(本轮审查 R1):就地写是先截断再写,没有原子性,而上一版把「写出异常就回写
 * 旧正文」当成了失败安全。可写失败往往不是一次性的(配额耗尽、设备 EIO、挂载转只读),那时
 * **回写同样失败**,盘上留下半截正文、备份完整,而 CLI 读的是活动那份。预演把这一整类挡在
 * 动手之前;挡不住的只剩「写到一半断电/被杀」,那一档任何非原子写都兜不住。
 */
function rehearse(target: string, body: string, create: boolean): string | null {
  const probe = `${target}.ash-publish-probe`;
  try {
    // 新建那一路:父目录得先有(gemini 的 `.gemini/`、kiro 的 `settings/` 这种子层)。
    // 顺序跟真写那一步一致 —— 建目录本身也是一次写,挡不住的话这一步就该失败。
    if (create) mkdirSync(dirname(target), { recursive: true });
    writeFileSync(probe, body, { encoding: "utf8", mode: 0o600 });
    const fd = openSync(probe, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* 预演产物,删不掉也不该拦住结论 */ }
  }
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
  const now = readForWrite(read.file);
  if (!now) return `要写 ${read.file} 之前又读不出它了`;
  // 别人动过 ⇒ 这一轮读到的那一版已经不作数,整条重做(见 publishFresh 的 ②)。
  if (now.text !== read.text) throw STALE;
  // 预演先行(R1):落不下去就在这里收手,用户那份还是原样。
  const dry = rehearse(resolveTarget(read.file), body, read.text === null);
  if (dry) return `写不进 ${read.file} 所在的目录（${dry}），所以这次什么都没写`;
  publishInPlace(read, body);
  const after = readForWrite(read.file);
  if (!after || after.text !== body) {
    return `写完 ${read.file} 读回来跟刚批准的那份不一样（有别的程序也在写它？），请手工检查一遍`;
  }
  return null;
};
