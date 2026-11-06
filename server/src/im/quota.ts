// 飞书 API 月额度：计数 + 到线降级。
//
// 免费版自建应用每月 1 万次 API 调用（用户 2026-11-06 在开发者后台核实；开放平台没有查询
// 额度的接口，只能自己数）。额度用尽后所有调用都被拒，连「点完按钮把卡改成结果」都做不了，
// 所以闸卡在**发请求之前**，按这次调用的用途决定还发不发：
//
//   用途        normal  frugal(≥70%)  essential(≥90%)  exhausted(≥99%)
//   reaction      ✓        ✗              ✗                ✗      「已收到」表情，纯装饰
//   resolved      ✓        ✓              ✗                ✗      把旧卡改成「已在别处处理」
//   notice        ✓        ✓              ✗                ✗      完成/门禁通知、上线提示、汇总卡
//   info          ✓        ✓              ✗                ✗      查机器人/群信息
//   download      ✓        ✓              ✓                ✗      用户发来的附件
//   decision      ✓        ✓              ✓                ✗      提问/待验收/失败/驳回/闸口卡
//   reply         ✓        ✓              ✓                ✗      对话回复、命令回执
//   result        ✓        ✓              ✓                ✓      回写「你刚点的那一下」的结果
//   token         ✓        ✓              ✓                ✓      上面任何一种都要先有 token
//
// 卡片回调里的同步回卡不经过 API、不花额度 —— 能在回调里改完的卡，一律在回调里改。
//
// 计数在内存里加、异步落库（im_meta 的 `usage:<月份>`）。崩溃时最多丢最后几次，偏少不偏多；
// 月份按北京时间切，与飞书后台的口径一致。
import type { ImApiKind, ImQuotaLevel, ImUsage } from "@ash/shared";
import { readMeta, readOptions, writeMeta } from "./meta.js";

export type ImPurpose =
  | "reaction" | "resolved" | "notice" | "info" | "download" | "decision" | "reply" | "result" | "token";

const ALLOWED: Record<ImQuotaLevel, ReadonlySet<ImPurpose>> = {
  normal: new Set(["reaction", "resolved", "notice", "info", "download", "decision", "reply", "result", "token"]),
  frugal: new Set(["resolved", "notice", "info", "download", "decision", "reply", "result", "token"]),
  essential: new Set(["download", "decision", "reply", "result", "token"]),
  exhausted: new Set(["result", "token"]),
};

export function levelOf(calls: number, quota: number): ImQuotaLevel {
  const ratio = quota > 0 ? calls / quota : 1;
  if (ratio >= 0.99) return "exhausted";
  if (ratio >= 0.9) return "essential";
  if (ratio >= 0.7) return "frugal";
  return "normal";
}

export function purposeAllowed(level: ImQuotaLevel, purpose: ImPurpose): boolean {
  return ALLOWED[level].has(purpose);
}

/** 北京时间的自然月，形如 2026-11。 */
export function monthOf(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 7);
}

interface Counter {
  month: string;
  calls: number;
  byKind: Partial<Record<ImApiKind, number>>;
}

export class QuotaMeter {
  private counter: Counter | null = null;
  private quota = 10_000;
  private persisting: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  /** 启动时从库里读回本月计数与额度设置。 */
  async load(): Promise<void> {
    const month = monthOf(this.now());
    const raw = await readMeta(`usage:${month}`);
    let parsed: Partial<Counter> = {};
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* 坏了从 0 数 */ }
    this.counter = {
      month,
      calls: Number.isInteger(parsed.calls) ? parsed.calls! : 0,
      byKind: parsed.byKind && typeof parsed.byKind === "object" ? parsed.byKind : {},
    };
    this.quota = (await readOptions()).monthlyQuota;
  }

  setQuota(quota: number): void {
    this.quota = quota;
  }

  private current(): Counter {
    const month = monthOf(this.now());
    if (!this.counter || this.counter.month !== month) this.counter = { month, calls: 0, byKind: {} };
    return this.counter;
  }

  level(): ImQuotaLevel {
    return levelOf(this.current().calls, this.quota);
  }

  allows(purpose: ImPurpose): boolean {
    return purposeAllowed(this.level(), purpose);
  }

  /** 发请求之前调：放行就记一次并返回 true。 */
  take(kind: ImApiKind, purpose: ImPurpose): boolean {
    if (!this.allows(purpose)) return false;
    const counter = this.current();
    counter.calls += 1;
    counter.byKind[kind] = (counter.byKind[kind] ?? 0) + 1;
    const snapshot = JSON.stringify({ calls: counter.calls, byKind: counter.byKind });
    const key = `usage:${counter.month}`;
    this.persisting = this.persisting
      .then(() => writeMeta(key, snapshot))
      .catch((error) => console.error("[ash] 飞书调用计数落库失败:", error));
    return true;
  }

  usage(): ImUsage {
    const counter = this.current();
    return { month: counter.month, calls: counter.calls, quota: this.quota, level: this.level(), byKind: { ...counter.byKind } };
  }

  /** 测试用：等计数落库。 */
  flush(): Promise<void> {
    return this.persisting;
  }
}
