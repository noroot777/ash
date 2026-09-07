import type { TaskMode } from "@ash/shared";
import { ArrowRight } from "@phosphor-icons/react";

const STARTERS = [
  { label: "解决一个问题", detail: "现象 → 原因 → 修复与验证", symbol: "⌁", mode: "single", body: "请帮我定位并修复这个问题。\n\n现象：\n复现步骤：\n期望结果：\n\n完成后，请运行相关检查并说明根因。" },
  { label: "做一个新功能", detail: "目标 → 边界 → 交付标准", symbol: "＋", mode: "single", body: "我想增加一个新功能。\n\n使用场景：\n需要实现：\n不在本次范围：\n\n验收标准：" },
  { label: "讨论一个方案", detail: "比较取舍，形成共同结论", symbol: "⇄", mode: "duet", body: "请比较下面的方案，并形成一个可执行的结论。\n\n背景：\n候选方案：\n主要顾虑：\n\n请说明各自的收益、成本和推荐理由。" },
] satisfies { label: string; detail: string; symbol: string; mode: TaskMode; body: string }[];

export function ComposerStarters({ onPick }: { onPick: (body: string, mode: TaskMode) => void }) {
  return <section className="studio-starters" aria-label="任务示例">
    <p className="studio-help">选一个起点，接着写。已有正文会保留。</p>
    <div>{STARTERS.map((starter) => <button key={starter.label} type="button" onClick={() => onPick(starter.body, starter.mode)}>
      <span className="studio-starter-icon">{starter.symbol}</span><span><b>{starter.label}</b><small>{starter.detail}</small></span><ArrowRight size={12} />
    </button>)}</div>
  </section>;
}
