// 首启向导的后半段:实例模式定完之后,这台 ash 还缺什么才算「配起来了」。
//
// 前半段(自用 / 多人)在 auth/routes.ts 的 `/auth/setup`,判据是 `needsSetup`。
// 后半段是供应商 → 执行器 → 项目。它们各有各的设置页入口,但首次安装的人无从知道
// 该先去哪一个:装完打开只看到一句「还没有可用项目」,而真正拦着他的是「一个执行器
// 都没注册」—— 建了项目也派不动任务。所以由向导按依赖顺序串着问一遍。
//
// 判据为什么**不只看那个标志位**:`onboardedAt` 这个键是这一版才有的,老实例库里
// 一个字都没有。只认标志位的话,每一台升级上来的实例都会被糊一屏「欢迎,先加供应商」,
// 而它们早就在干活了。「已经有执行器或项目」是比任何标志位都硬的证据,所以它单独成
// 一条放行理由 —— 反过来,一台真的空库实例就算之前点过「以后再说」,也会凭 onboardedAt
// 继续放行,用户的表态不会因为他还没来得及建项目就被当没发生。
import type { Actor } from "./auth/context.js";
import { ownerIdOf } from "./auth/context.js";
import { filterOwned } from "./auth/owned.js";
import { ownPersonalSetting } from "./auth/personal-settings.js";
import { visibleProjectsFor } from "./auth/visibility.js";
import { db } from "./db/index.js";
import { agents } from "./db/schema.js";

/**
 * 这个人还需要被领着走一遍首启向导吗。
 *
 * 执行器按**个人面**口径数(filterOwned),项目按**可见性**口径数
 * (visibleProjectsFor) —— 跟 `/agents`、`/projects` 两条列表路由同一份判据,否则
 * 会出现「向导说你有执行器、列表里却一个都看不见」这种自相矛盾的首屏。
 */
export async function needsOnboarding(actor: Actor): Promise<boolean> {
  // **他自己**表过态才算(ownPersonalSetting 而不是 settingsFor):多人模式下全局那行
  // 说的是「转多人之前独自用这台机器的人走完过」,替不了今天刚加进来的那个人。
  if (await ownPersonalSetting(ownerIdOf(actor), "onboardedAt")) return false;
  const owned = await filterOwned(await db.select().from(agents), actor);
  if (owned.length) return false;
  return (await visibleProjectsFor(actor)).length === 0;
}
