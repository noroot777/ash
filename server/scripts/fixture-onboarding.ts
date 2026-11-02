// 浏览器用例里**服务真前端**的夹具,数据种完之后得补一句「这台机器已经走过首启向导」。
//
// 为什么非得补:向导的放行判据是一条持久表态(`src/onboarding.ts`),`ensureSchema()`
// 那一刻的存量盖章(`db/migrate-onboarding.ts`)只认「那时候已经有执行器或项目」——
// 而夹具恰恰是先 `ensureSchema()` 再插数据,盖章时库还是空的。于是 `AuthGate` 判
// needsOnboarding 为真,整个工作区被 `FirstRunWizard` 顶掉,用例只能等到超时(审计
// 2026-11-02:test-assistant-entry / test-chat-browser 几条就是这么红的,探针读回的
// body 是「1 供应商 2 执行器 3 项目」)。
//
// 这不是给测试开的后门:真实例上人要么走过向导、要么点过「以后再说」,`onboardedAt`
// 一定有值。夹具补这一句是让它跟真服务端在这一点上一致 —— 向导本身的回归在
// `test-onboarding-gate.ts`,那条用例才是专门盯这一格的。
//
// 两层 import 都在函数体里:夹具都是先改 `process.env.ASH_DB` 再动 src,顶层静态引用
// 会把 db 连接提前到临时库路径生效之前(那样就连到真库上了)。

/** 自用模式夹具:把全局那行 `onboardedAt` 盖上,跳过首启向导的后半段。 */
export async function markFixtureOnboarded(): Promise<void> {
  const { SINGLE_ACTOR } = await import("../src/auth/context.js");
  const { patchSettingsFor } = await import("../src/auth/personal-settings.js");
  await patchSettingsFor(SINGLE_ACTOR, { onboardedAt: new Date().toISOString() });
}
