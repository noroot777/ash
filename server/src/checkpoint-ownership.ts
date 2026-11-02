// 续跑凭证的**投递所有权**:这段交代现在由谁负责送,以及一张滞留的凭证**谁有权接管**。
//
// 为什么不能只靠进程内那张 Set 加一个墙钟租约戳(第 2 轮自由审查 F1,两个独立进程实测):
// `deliveringNow` 只覆盖本进程;条件更新把接管**线性化**了,但它证明不了「原发送方已经不在
// 送」—— 另一份 ash(`ASH_ALLOW_MULTI=1`)读到的租约跟「有租约、没人管」长得一模一样。
// 现场:实例 A 刚问过「这张票还是我的吗」、还没 spawn,实例 B 的对账接管它、按「没送出去」
// 把交代还给任务;A 照旧把原文送了出去 —— 于是同一段话既已送达、又重新变成待执行输入,
// 下一次继续再送一遍(CLI 收到次数 1 → 2)。
//
// 所以所有权要带**身份**,接管要有**证据**:
//
//  · 身份 = 每一笔认领/接管独有的 token(`scheduled_messages.delivering_owner`),里面带着
//    持有它的那个进程的 pid + **代次**(process-generation.ts 的戳,pid 会被复用)和本进程
//    这一次启动的随机数。墙钟戳做不到这件事:同毫秒接管不保证换值,而且它还要兼任「这条
//    租约多久了」—— 一个值同时当时间和身份,两头都证不住(审查对此点名)。
//
//  · 接管只认下面三条放行理由,其余一律不接管:
//      ① `mine` —— 这张票就是本进程开的(token 里的开机随机数是我的),而进程内已经没人
//         在送它。判定读失败时交回所有权那条路(F2)靠这一条被接着办。
//      ② `gone` —— token 里那个进程**证明得了已经不在了**:号没了,或者号还在、代次却变了
//         (= 这个号被别人接手了)。重启之后的恢复走的正是这一条(上一个进程的号已经没了)。
//      ③ `exclusive` —— **只给没有身份的旧凭证兜底**:单例锁在我手里,而且在线登记里没有
//         别人。反过来拿锁给有身份的行放行是不成立的 —— 那把锁只证明「没有别的守锁实例」,
//         而 `ASH_ALLOW_MULTI=1` 的实例压根不写锁,它恰好就是这条缝的现场。
//    读不出代次、两份读数问法不同、老库那种没有 token 的行:**都不算证据**。宁可让那张
//    凭证多滞留一会儿(启动被拒的理由里会如实说它正由谁负责),也不能把一个可能正在送的
//    交代归还回任务 —— 前者等得起,后者是同一段话执行两遍。
//
// 代价说明白:代次在某台机器上**一直**问不出来时,一张「持有者已经崩了、号又正好被别人复用」
// 的票就只能滞留着(启动被拒的理由里会如实说它挂在谁名下,不是一句没有出路的死信)。方向是
// 有意选的 —— 滞留等得起,重复投递等不起。
import { otherLiveAshPresenceForAny } from "./ash-presence.js";
import { resolveAshDbFile } from "./db/path.js";
import { RUNS_DIR } from "./paths.js";
import { isPidAlive } from "./platform.js";
import { processGenerationSync, sameGenerationSource } from "./process-generation.js";
import { resourceKeysFor } from "./resource-claim.js";
import { liveLockToken } from "./singleton.js";
import { id } from "./util.js";

/** 本进程这一次启动的随机数:同一个 pid 重启之后,token 里的这一段就不一样了。 */
const BOOT = id();
const SEPARATOR = "|";
let selfGeneration: string | null = null;

/**
 * 本进程自己的代次。**取到了才缓存**:在模块加载那一拍取一次、失败就记住 null 的话,一次
 * 瞬时的 `ps` 失败会让这个进程此后开出的每一张票都没有代次,而没有代次的票别人只能靠
 * 「号没了」来证明我已不在 —— 号一被复用就谁也证不动了。
 */
function selfGenerationNow(): string | null {
  return selfGeneration ??= processGenerationSync(process.pid);
}

/** 开一张**新身份**:每次认领、每次接管都换一个,所以它同时是「第几代所有权」。 */
export function mintCheckpointOwner(): string {
  return [process.pid, selfGenerationNow() ?? "?", BOOT, id()].join(SEPARATOR);
}

type CheckpointOwner = { pid: number; generation: string | null; boot: string };

function parseCheckpointOwner(token: string | null): CheckpointOwner | null {
  if (!token) return null;
  const parts = token.split(SEPARATOR);
  if (parts.length !== 4) return null;
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, generation: parts[1] === "?" ? null : parts[1]!, boot: parts[2]! };
}

/** 接管的放行理由(见文件头),`null` = 证不出来,这一趟不许接管。 */
export type CheckpointSeizure = "exclusive" | "mine" | "gone";

export function checkpointSeizureReason(token: string | null): CheckpointSeizure | null {
  const owner = parseCheckpointOwner(token);
  // ① 老库那种没有身份的行(或者身份读不懂):只有「这台机器上确实就我一个 ash」才接得走。
  //    这一条排在身份之后:**不能**反过来用单例锁给有身份的行放行 —— 那把锁只证明「没有
  //    别的守锁实例」,而 ASH_ALLOW_MULTI 起的那种压根不写锁(它恰好就是这条缝的现场)。
  if (!owner) return soleLiveInstance() ? "exclusive" : null;
  if (owner.boot === BOOT) return "mine";        // ② 本进程开的票,而这里已经没人在送它
  if (!isPidAlive(owner.pid)) return "gone";     // ③ 号没了
  const current = processGenerationSync(owner.pid);
  // 代次问不出来(或者两份读数问法不同、根本不能比)⇒ 不是证据,不接管。
  if (!owner.generation || !current || !sameGenerationSource(owner.generation, current)) return null;
  return owner.generation === current ? null : "gone";
}

/**
 * 「这份库此刻只有我这一个 ash 在用」—— 两半都要:单例锁在我手里(没有别的守锁实例),
 * 而且在线登记里没有别人(`ASH_ALLOW_MULTI=1` 的实例不写锁,只留登记)。
 *
 * 任一半答不出来就按「可能有别人」处理:这一问只用来给**没有身份的旧凭证**放行,宁可让它
 * 多滞留一会儿。
 */
function soleLiveInstance(): boolean {
  if (liveLockToken() === null) return false;
  try {
    return otherLiveAshPresenceForAny(resourceKeysFor(resolveAshDbFile(), RUNS_DIR)) === null;
  } catch {
    return false;
  }
}

/** 这张票此刻挂在谁名下 —— 只给日志和「为什么还不能启动」那句话用。 */
export function describeCheckpointOwner(token: string | null): string {
  const owner = parseCheckpointOwner(token);
  if (!owner) return token ? "一张读不懂的所有权凭证" : "没有所有权凭证的旧凭证";
  if (owner.boot === BOOT) return `本进程(pid ${owner.pid})`;
  return `另一个进程(pid ${owner.pid}${owner.generation ? "" : "、代次不详"})`;
}
