// `/settings` 在前端的单点:哪一份应答算数、页面该拿哪一份显示、同一项设置的多次保存
// 按什么顺序落到服务端。
//
// 为什么要有这么个东西:这一份设置有十来个写入点(设置页每张卡各一个 PATCH)和四五个
// 读取点(工作台开场、设置页、技能清单、新建面板),它们彼此不知情,应答乱序是常态。
// 而这份设置里有一项**按错了就不可撤销**——「输入框按哪一下算发送」:采纳一份旧应答
// 的后果是用户下一个回车把没写完的任务发出去。
//
// 判据三条:
//  · **同字段的写排队发**。并发发出的两条 PATCH 到达服务端的顺序没人保证,旧那条后到
//    就把用户最后选的那一档覆盖回去 —— 那是**服务端里存的东西错了**,前端挑哪份应答
//    算数救不回来(第 3 轮审查问题 1)。不同字段互不排队。
//  · **写按字段拍定**。一次写的应答只对**这次 patch 里出现的那几个字段**算真相;应答
//    里其余字段只是顺带捎回的同期快照,拿它去盖别的字段,就是用一份旧值压掉另一次成功
//    的保存(第 2 轮审查问题 2)。
//  · **读必须全程不跨写**。读发出时就有写没落地、发出后又有写发起、回来时还有写没
//    落地——三者任一成立,它读到的都可能是某次写之前的那一份,一律作废。
//
// 这三条都是前三轮踩出来的,每一条都有用例钉着(`web/scripts/test-send-key.mjs`):
//  · 按「请求发出的先后」排序(第 1 轮那版)是错的——PATCH 先发、新挂载的输入框随后
//    发一条 GET,GET 读到写之前的旧值却拿着更大的号,成功的写反被丢掉。
//  · 只看「回来时有没有写在途」(第 2 轮那版)漏了整段跨过去的情形:PATCH 开始 → GET
//    读到旧值 → PATCH 完成 → GET 迟到的应答回来,两个端点都「没有写在途」,中间却
//    完整跨过了一次保存。
//  · 所有字段共用一条写序号(第 2 轮那版)会让不相关的两张卡互相拆台:发送键 PATCH
//    先发、技能间隔 PATCH 后发先完成,成功的发送键应答就因为「不是最后发出的那次」
//    被拒,后一次保存失败也一样拒。
//  · 只在应答层排序(第 3 轮那版)管不到服务端里存的是什么:保存还在途中离开设置页
//    再回来,卡片级的「保存中」随卸载消失,用户又改几次;那条被延迟的旧 PATCH 最后
//    才到达服务端,把他最后选的那一档覆盖掉,刷新就退档。
//
// 被判定为过期的应答**一个字都不往外发**:交回的是合并后的权威快照,所以设置页那
// 十来个 `setSettings(await api.patchSettings(...))` 不会被一份旧对象倒灌——在一处
// 收口,好过让每个调用点自己想起来比一次。
//
// 交出去的快照里**只有服务端确认过的值**,排着队还没落地的选择一律不叠进去。叠进去
// 的那一版(第 3 轮那版)会把未保存的值灌进设置页自己持有的 state:保存失败时这里能
// 把按键行为退回去,却退不了别人手里那份 state,于是下拉和「当前」说明继续声称一个
// 没存成的档位正在生效,而裸回车按的是旧档 —— 界面撒谎比显示滞后危险得多
// (第 4 轮审查问题 1)。在途的选择只经 `publish()` 推给 sendKey,而显示那一档的卡片
// 直接订阅它(`useComposerSendKey`),所以显示、提示、按键三者同源,不会各说一套。
import type { AppSettings } from "@ash/shared";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";
import { json, request } from "./apiClient.ts";
import { syncHostCliPolicy } from "./hostCliPolicy.ts";
import { syncComposerSendKey } from "./sendKey.ts";

type SettingKey = keyof AppSettings;

let writeSeq = 0;
/** 排了队还没落地的写有多少笔。从**排队那一刻**就计数:这期间读到的值随时会被盖掉。 */
let unsettledWrites = 0;
/** 已被服务端确认过的那一份。在途的选择不写进来。 */
let latest: AppSettings | null = null;
/** 每个字段最近一次被「写」拍定时的写序号;没被写拍过的字段不在表里。 */
const writtenAt = new Map<SettingKey, number>();
/** 排着队还没落地的目标值:界面显示和按键行为都跟它走(卡片上写的是「改完立刻生效」)。 */
const pending = new Map<SettingKey, unknown>();
/** 每个字段上最后一笔排队的写;同字段的下一笔必须等它真正落地才发。 */
const tail = new Map<SettingKey, Promise<void>>();

/**
 * 读一份设置。缺字段补出厂默认——老服务端不认识新设置项时,界面上会冒出
 * 「每 undefined 秒」。
 */
export async function readSettings(): Promise<AppSettings> {
  const seenWrites = writeSeq;
  const startedUnsettled = unsettledWrites > 0;
  const fresh = await request<AppSettings>("/settings");
  const full = { ...DEFAULT_APP_SETTINGS, ...fresh };
  if (startedUnsettled || seenWrites !== writeSeq || unsettledWrites > 0) return latest ?? full;
  // 全程没跨写 ⇒ 此刻也没有写排着队 ⇒ 这份快照含了到目前为止的全部写,字段账可以清空
  // (之后发起的写序号都比现在大,清空不会让它们误判成「已被更晚的写拍过」)。
  writtenAt.clear();
  return apply(full);
}

/**
 * 写一份设置。同字段排队,不同字段并发;取号在**队列放行之后、请求发出之前**,否则
 * 排队期间的读会以为自己没跨写。
 */
export function writeSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // 值为 undefined 的键 `JSON.stringify` 会丢掉,服务端根本不会写它——不能算这次
  // 写拍定了的字段,也不该为它排队。
  const keys = (Object.keys(patch) as SettingKey[]).filter((key) => patch[key] !== undefined);
  const queuedBefore = keys.map((key) => tail.get(key)).filter((promise): promise is Promise<void> => !!promise);
  for (const key of keys) pending.set(key, patch[key]);
  unsettledWrites += 1;
  publish();   // 选完立刻生效,不等一个往返;保存失败时由下面的 finally 退回去
  // 这一笔在队列里的身份。用「自己放行」的 promise 而不是 settled 本身:同字段的下一笔
  // 要等的是「前一笔已经落地**且**账已经收干净」,不是「前一笔的 await 返回了」。
  let release = () => {};
  const guard = new Promise<void>((resolve) => { release = resolve; });
  const settled = (async () => {
    try {
      // guard 在前一笔的 finally 里**无条件**放行:一次 503 不该把这个字段永久堵住。
      await Promise.all(queuedBefore);
      const seq = (writeSeq += 1);
      const fresh = await request<AppSettings>("/settings", json("PATCH", patch));
      return adoptWrite({ ...DEFAULT_APP_SETTINGS, ...fresh }, seq, keys);
    } finally {
      unsettledWrites -= 1;
      for (const key of keys) {
        // 后面又排了新的,这个字段的在途值和队尾都归它管,别替它收。
        if (tail.get(key) !== guard) continue;
        tail.delete(key);
        pending.delete(key);
      }
      publish();   // 收敛:成功时 latest 已是新值,失败时退回服务端确认过的那一份
      release();   // 放行同字段排在后面的那一笔
    }
  })();
  for (const key of keys) tail.set(key, guard);
  return settled;
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
 * 「此刻该按哪一档」= 服务端确认过的那份,叠上排着队还没落地的选择。**只给 publish 用**
 * —— 它的结果不进任何对外交出的快照(见文件头)。
 *
 * 为什么在途的选择优先:卡片上写着「改完立刻生效,不用刷新页面」;而且少了这一层,
 * 离开设置页再回来时下拉会把在途的选择显示成没发生过,用户据此再改一次就是一串同字段
 * 的写(第 3 轮审查问题 1)。
 */
function shownFrom(confirmed: AppSettings): AppSettings {
  if (pending.size === 0) return confirmed;
  const merged = { ...confirmed } as unknown as Record<string, unknown>;
  for (const [key, value] of pending) merged[key] = value;
  return merged as unknown as AppSettings;
}

/**
 * 把两档「页面要跟着变脸」的政策推出去 ——「CLI 额度」给 hostCliPolicy,「哪一下算
 * 发送」给 sendKey。还没读到任何设置时**什么都不推**:未知态下裸回车一律当换行,
 * 不拿出厂默认冒充用户的选择(第 2 轮审查问题 2)。
 *
 * 钉在这里而不是各个调用点:前端学到这些档位的路**只有 `/settings` 那两条**,而漏掉
 * 任何一条的表现是「改了设置,界面要刷新页面才对」。
 */
function publish(): void {
  if (!latest) return;
  const shown = shownFrom(latest);
  // 这两档对「在途的选择」的态度相反,别顺手统一:
  //  · CLI 额度决定的是**向服务端要哪一份目录**,必须等服务端真写进去再推。拿在途值
  //    提前推,重取回来的还是切换前那份目录,而这一档的值已经变过一次,服务端确认之后
  //    就不会再触发第二次重取 —— 候选永远停在旧目录上(`test:cli-effort-policy`)。
  //  · 「哪一下算发送」是纯前端语义,知道档位就能决定按键行为,用在途值立刻生效正是
  //    卡片上写的「改完立刻生效,不用刷新页面」。
  syncHostCliPolicy({ instanceMode: latest.instanceMode, sharedHostCli: latest.sharedHostCli });
  syncComposerSendKey(shown.composerSendKey);
}

function apply(settings: AppSettings): AppSettings {
  latest = settings;
  publish();
  return settings;
}
