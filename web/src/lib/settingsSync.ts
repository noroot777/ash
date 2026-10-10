// `/settings` 的**新旧判定**在前端的单点:哪一份应答算数、页面该拿哪一份显示。
//
// 为什么要有这么个东西:这一份设置有十来个写入点(设置页每张卡各一个 PATCH)和四五个
// 读取点(工作台开场、设置页、技能清单、新建面板),它们彼此不知情,应答乱序是常态。
// 而这份设置里有一项**按错了就不可撤销**——「输入框按哪一下算发送」:采纳一份旧应答
// 的后果是用户下一个回车把没写完的任务发出去。
//
// 判据只有一条:**写比读权威**。
//  · 写的应答是服务端在回「我刚存成了什么」,它就是那一刻的真相;同时发出的写里,
//    最后发出的那个代表用户最后的意思。
//  · 读的应答只有在「它没跨过任何一次写」时才可信 —— 发出之后又有写发出、或者它回来
//    时还有写在途,它读到的都可能是写之前的那一份。
//
// 曾经按「请求发出的先后」排序(第 1 轮审查修的那版)。那个判据是错的:PATCH 先发、
// 新挂载的输入框随后发一条 GET,GET 读到的是写之前的旧值却拿着更大的号,于是成功的
// 写反而被丢掉(第 2 轮审查问题 1)。发出顺序不是数据版本顺序。
//
// 被判定为过期的应答**一个字都不往外发**:`adopt*` 交回最近一次被采纳的那份快照,
// 所以设置页那十来个 `setSettings(await api.patchSettings(...))` 不会被一份旧对象
// 倒灌(第 2 轮审查问题 3)——在一处收口,好过让每个调用点自己想起来比一次。
import type { AppSettings } from "@ash/shared";
import { syncHostCliPolicy } from "./hostCliPolicy.ts";
import { syncComposerSendKey } from "./sendKey.ts";

let writeSeq = 0;
let writesInFlight = 0;
let latest: AppSettings | null = null;

/** 一次读取的随身票据:记下它发出时「写到第几次了」。 */
export interface SettingsReadToken {
  seenWrites: number;
}

/** 读取在**发出之前**取票。 */
export const beginSettingsRead = (): SettingsReadToken => ({ seenWrites: writeSeq });

/** 写入在**发出之前**取号;不管成败,完事都要 `endSettingsWrite()`。 */
export function beginSettingsWrite(): number {
  writesInFlight += 1;
  return (writeSeq += 1);
}

export function endSettingsWrite(): void {
  writesInFlight -= 1;
}

/** 读取的应答。跨过写就不算数。 */
export function adoptSettingsRead(fresh: AppSettings, token: SettingsReadToken): AppSettings {
  const crossedAWrite = token.seenWrites !== writeSeq || writesInFlight > 0;
  return crossedAWrite ? (latest ?? fresh) : apply(fresh);
}

/** 写入的应答。只有**最后发出**的那次写说了算。 */
export function adoptSettingsWrite(fresh: AppSettings, seq: number): AppSettings {
  return seq === writeSeq ? apply(fresh) : (latest ?? fresh);
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
