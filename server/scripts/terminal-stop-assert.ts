// 停止类回归的**台子口径**:哪些事实属于被测代码,哪些只是本机此刻的忙闲。
//
// 记号扫描(terminal-launch-survivors.ts 文件头③)把「同属主、出生在这次启动之后、核不上
// 归属」的孤儿一律算成「这一趟没问全」—— 那一档只能辅助找人,不能排除人。而本机随时在生
// 这种号:macOS 的 `mdworker_shared`、各种 XPC 服务每隔几秒就有新的被 launchd 收养
// (实测这台机器上同属主的孤儿常年 370 个上下),并行跑着的另一个用例起的 detached 进程
// 同样算。于是同一段代码在安静的机器上报「干净的已停止」,在忙的机器上按设计多带一句
// notice、并留下一条纯历史记录 —— **两种都对**。
//
// 所以台子只钉真正属于它的那一半:停止成功、而且账上没有**自家**核不上的号。封口
// (`stop.kind === "verified"`)这件事只在「一个核不上的号都没有」时才断言,口径跟
// test-stop-verification.ts 里那段 `if (!scan.unanswered.length)` 完全一致。
//
// 反面教材是审计跑出来的三条稳定红(test-project-commands / test-service-ports /
// test-terminal-capacity):它们钉的是裸 `{stopped:true}`、`stop.kind === "verified"`、
// 会话记录数 16,全都隐含「测试窗口内本机不得有别的同属主新进程」这个台子假设。
import assert from "node:assert/strict";

export type StopBody = { stopped?: boolean; unresolved?: number[]; notice?: string };

/** 「停成功了,而且没有自家的号留在账上」。`notice` 随本机忙闲出现,不参与判定。 */
export function assertStopBody(body: unknown, stopped: boolean, label = "停止应答"): void {
  const seen = body as StopBody;
  assert.equal(seen.stopped, stopped, `${label}:stopped 该是 ${stopped}`);
  assert.deepEqual(seen.unresolved ?? [], [], `${label}:不该有核不上的自家号留在账上`);
}
