// 浏览器用例的夹具服务端只挂自己用得着的那几条路由。`/api/settings` 看着与聊天、助手
// 无关,但**前端开场一定会读它一次**:「输入框按哪一下算发送」那一档在学到之前,裸回车
// 一律当换行(`web/src/lib/sendKey.ts` 顶部说明了为什么宁可按保守的那一档)。
//
// 不挂这条的话,用例里「刷新完立刻按回车发送」会落在那段未知窗口里,表现成「回车没
// 反应」—— 而真实服务端从来没有这个窗口。所以这不是给测试开的后门,是让夹具跟真服务端
// 在这一点上一致。
import type { Hono } from "hono";
import { DEFAULT_APP_SETTINGS } from "@ash/shared";

export function mountFixtureSettings(api: Hono): void {
  api.get("/settings", (c) => c.json(DEFAULT_APP_SETTINGS));
}
