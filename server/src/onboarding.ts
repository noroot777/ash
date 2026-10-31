// 首启向导的后半段:实例模式定完之后,这台 ash 还缺什么才算「配起来了」。
//
// 前半段(自用 / 多人)在 auth/routes.ts 的 `/auth/setup`,判据是 `needsSetup`。
// 后半段是供应商 → 执行器 → 项目。它们各有各的设置页入口,但首次安装的人无从知道
// 该先去哪一个:装完打开只看到一句「还没有可用项目」,而真正拦着他的是「一个执行器
// 都没注册」—— 建了项目也派不动任务。所以由向导按依赖顺序串着问一遍。
//
// **判据只有一条持久记录,不看库里有什么。** 这里曾经写过「已经有执行器或项目就算
// 配过」,本意是给升级上来的老实例兜底,实测却是个误判:首装的人在向导第二步刚注册
// 完执行器、一刷新向导就自己消失了,人被丢在「还没有可用项目」那一屏上;多人模式下
// 被提前加进共享项目的新同事更是整段跳过,连自己的执行器都没配。资源存在只能证明
// 资源存在,证明不了「这个人被领着走过一遍」。老实例的豁免改在**版本边界上一次性**
// 盖章(`db/migrate-onboarding.ts`),那一刻之后库里长出什么都不再改变结论。
import type { Actor } from "./auth/context.js";
import { ownerIdOf } from "./auth/context.js";
import { ownPersonalSetting } from "./auth/personal-settings.js";

/**
 * 这个人还需要被领着走一遍首启向导吗。
 *
 * **他自己**表过态才算(`ownPersonalSetting` 而不是 `settingsFor`):多人模式下全局
 * 那行的意思是「转多人之前独自用这台机器的人走完过」,替不了今天刚加进来的那个人。
 * 自用转多人时那条表态会跟着存量数据一起过户给初始管理员(`auth/conversion.ts`)。
 */
export async function needsOnboarding(actor: Actor): Promise<boolean> {
  return !(await ownPersonalSetting(ownerIdOf(actor), "onboardedAt"));
}
