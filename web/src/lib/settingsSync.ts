// `/settings` 的**新旧判定**在前端的单点:哪一份应答算数、页面该拿哪一份显示。
//
// 为什么要有这么个东西:这一份设置有十来个写入点(设置页每张卡各一个 PATCH)和四五个
// 读取点(工作台开场、设置页、技能清单、新建面板),它们彼此不知情,应答乱序是常态。
// 而这份设置里有一项**按错了就不可撤销**——「输入框按哪一下算发送」:采纳一份旧应答
// 的后果是用户下一个回车把没写完的任务发出去。
//
// 判据两条:
//  · **写按字段拍定**。一次写的应答是服务端在回「我刚存成了什么」,但它只对**这次
//    patch 里出现的那几个字段**算真相;应答里其余字段只是顺带捎回的同期快照,拿它去
//    盖别的字段,就是用一份旧值压掉另一次成功的保存。同一字段上并发的写,以最后发出
//    的那次为准(那才是用户最后的意思)。
//  · **读必须全程不跨写**。读发出时就有写在途、发出后又有写发起、回来时还有写在途
//    ——三者任一成立,它读到的都可能是某次写之前的那一份,一律作废。
//
// 这两条都是前两轮踩出来的:
//  · 按「请求发出的先后」排序(第 1 轮那版)是错的——PATCH 先发、新挂载的输入框随后
//    发一条 GET,GET 读到写之前的旧值却拿着更大的号,成功的写反被丢掉。
//  · 只看「回来时有没有写在途」(第 2 轮那版)漏了整段跨过去的情形:PATCH 开始 → GET
//    读到旧值 → PATCH 完成 → GET 迟到的应答回来,两个端点都「没有写在途」,中间却
//    完整跨过了一次保存(第 3 轮问题 1)。
//  · 所有字段共用一条写序号(第 2 轮那版)会让不相关的两张卡互相拆台:发送键 PATCH
//    先发、技能间隔 PATCH 后发先完成,成功的发送键应答就因为「不是最后发出的那次」
//    被拒,后一次保存失败也一样拒(第 3 轮问题 2)。两个互不冲突的部分写入都该生效。
//
// 被判定为过期的应答**一个字都不往外发**:交回的是合并后的权威快照,所以设置页那
// 十来个 `setSettings(await api.patchSettings(...))` 不会被一份旧对象倒灌——在一处
// 收口,好过让每个调用点自己想起来比一次。
import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { json, request } from "./apiClient.ts";
import { syncHostCliPolicy } from "./hostCliPolicy.ts";
import { syncComposerSendKey } from "./sendKey.ts";

type SettingKey = keyof AppSettings;

let writeSeq = 0;
let writesInFlight = 0;
let latest: AppSettings | null = null;
/** 每个字段最近一次被「写」拍定时的写序号;没被写拍过的字段不在表里。 */
const writtenAt = new Map<SettingKey, number>();

/**
 * 读一份设置。缺字段补出厂默认——老服务端不认识新设置项时,界面上会冒出
 * 「每 undefined 秒」。
 */
export async function readSettings(): Promise<AppSettings> {
  const seenWrites = writeSeq;
  const startedMidWrite = writesInFlight > 0;
  const fresh = await request<AppSettings>("/settings");
  const full = { ...DEFAULT_APP_SETTINGS, ...fresh };
  if (startedMidWrite || seenWrites !== writeSeq || writesInFlight > 0) return latest ?? full;
  // 全程没跨写 ⇒ 此刻也没有写在途 ⇒ 这份快照含了到目前为止的全部写,字段账可以清空
  // (之后发起的写序号都比现在大,清空不会让它们误判成「已被更晚的写拍过」)。
  writtenAt.clear();
  return apply(full);
}

/** 写一份设置。取号必须在**请求发出之前**,否则同期的读会以为自己没跨写。 */
export async function writeSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // 值为 undefined 的键 `JSON.stringify` 会丢掉,服务端根本不会写它——不能算这次
  // 写拍定了的字段。
  const keys = (Object.keys(patch) as SettingKey[]).filter((key) => patch[key] !== undefined);
  writesInFlight += 1;
  const seq = (writeSeq += 1);
  try {
    const fresh = await request<AppSettings>("/settings", json("PATCH", patch));
    return adoptWrite({ ...DEFAULT_APP_SETTINGS, ...fresh }, seq, keys);
  } finally {
    writesInFlight -= 1;
  }
}

/** 把一次写的应答按字段并进权威快照:只认它自己写的那几个,且不许盖更晚的写。 */
function adoptWrite(fresh: AppSettings, seq: number, keys: readonly SettingKey[]): AppSettings {
  const merged = { ...(latest ?? fresh) } as unknown as Record<string, unknown>;
  const confirmed = fresh as unknown as Record<string, unknown>;
  let accepted = false;
  for (const key of keys) {
    if ((writtenAt.get(key) ?? 0) > seq) continue;
    writtenAt.set(key, seq);
    merged[key] = confirmed[key];
    accepted = true;
  }
  if (!accepted && latest) return latest;
  return apply(merged as unknown as AppSettings);
}

/**
 * 真正采纳一份设置:记成最新快照,并把两档「页面要跟着变脸」的政策推出去 ——
 * 「CLI 额度」给 hostCliPolicy,「哪一下算发送」给 sendKey。
 *
 * 钉在这里而不是各个调用点:前端学到这些档位的路**只有 `/settings` 那两条**,而漏掉
 * 任何一条的表现是「改了设置,界面要刷新页面才对」。
 */
function apply(settings: AppSettings): AppSettings {
  latest = settings;
  syncHostCliPolicy({ instanceMode: settings.instanceMode, sharedHostCli: settings.sharedHostCli });
  syncComposerSendKey(settings.composerSendKey);
  return settings;
}
