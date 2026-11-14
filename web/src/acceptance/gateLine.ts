import type { AcceptGateState, AcceptGateView } from "@ash/shared/accept-gate";
import { ACCEPT_GATE_BASELINE_LABELS } from "@ash/shared/accept-gate";
import type { CheckTone } from "./CheckRow.tsx";

/**
 * 前提列里「验收前置命令」那一行此刻该怎么说。纯函数：只读门禁状态，吐这一行的状态词、调子、
 * 要不要日志、行尾出哪个出路。画法在 GateCheck.tsx。
 *
 * 状态词覆盖原先那张卡用标题区分的全部情形，但只说状态、不解释机制：没跑过、在跑、通过还作数、
 * 通过但不作数（一句短原因）、没过（交没交给任务）、准备命令没过、入口不在被测的树里、被取消或
 * 打断、进程还没退干净、本机能力不可用、源码输入不可用、状态读不出来。
 */
export type GateLine = {
  tone: CheckTone;
  /** 这一行摆的命令原文；回执里只有「通过」那一档认得出是哪一条，其余几档不摆（没有凭据可指）。 */
  command: string | null;
  word: string;
  /** 日志那一层摆哪一次；null = 没有日志可看。 */
  run: AcceptGateView | null;
  /** 没通过时日志默认展开：红在哪一条就在最后几行。 */
  openLog: boolean;
  /** 行尾出路。 */
  stop: boolean;
  forceRelease: boolean;
  handOff: boolean;
  retry: boolean;
  /** 这一刻能不能就地改设置（还得有项目管理权限，调用方再判）。 */
  editable: boolean;
};

export type GateLineInput = {
  state: AcceptGateState | null;
  error: string | null;
  running: AcceptGateView | null;
  runningFor: string | null;
  latest: AcceptGateView | null;
  /** 已验收（或已合并）：这一行换成回执。 */
  settled: boolean;
  /** 停在中途那道关口：这一按只是放行，不预告「验收时运行」。 */
  atFinalGate: boolean;
  now?: number;
};

export function gateLine(input: GateLineInput): GateLine | null {
  const { state, error, running, runningFor, latest, settled, atFinalGate } = input;
  const base = { run: null, openLog: false, stop: false, forceRelease: false, handOff: false, retry: false, editable: false };
  // 读不出来**先说出来**：这不等于「没有命令在跑」，按钮也不许放开。还在读就不出这一行（读取中
  // 只禁用主按钮加转圈，不让一行字闪进来又闪出去）。
  if (!state) return error ? { ...base, tone: "block", command: null, word: "状态读不出来", retry: true } : null;
  const unconfirmed = error ? "，状态待核对" : "";
  if (running) {
    if (running.status === "running") {
      return { ...base, tone: error ? "idle" : "running", command: running.command, word: `运行中 · ${runningFor ?? ""}${unconfirmed}`,
        run: running, stop: true, retry: !!error };
    }
    return { ...base, tone: "warn", command: running.command, word: `进程还没退干净${unconfirmed}`, run: running,
      forceRelease: !!running.processPending, retry: !!error };
  }
  if (settled) return receipt(state, latest, error);
  // 只是放行那一站：前置命令在最终验收时才跑。
  if (!atFinalGate) return null;
  // 上次读到「没设」、这次读不出来：主按钮照样锁着，这一行得说出原因、给出重试。
  if (!state.command) return error ? { ...base, tone: "block", command: null, word: "状态读不出来", retry: true } : null;
  const line = (tone: CheckTone, word: string, more: Partial<GateLine> = {}): GateLine =>
    ({ ...base, tone: error ? "idle" : tone, command: state.command, word: `${word}${unconfirmed}`, editable: true, retry: !!error, ...more });
  if (state.unavailable) return line("block", "本机能力不可用");
  if (state.sourceError) return line("block", "源码输入不可用");
  if (!latest) return line("idle", "验收时运行");
  // 最近一次跑的是另一条命令：它的红说的不是现在这条（绿的那种由下面「命令变了」说）。日志还留着可看。
  if (latest.status !== "passed" && latest.command !== state.command) return line("idle", "验收时运行", { run: latest });
  if (latest.status === "passed") {
    if (!latest.stale) return line("passed", `通过 · ${ago(latest.finishedAt ?? latest.startedAt, input.now)}`, { run: latest });
    return line("idle", `通过，但${staleReason(state, latest)}`, { run: latest });
  }
  if (latest.status === "failed") {
    const what = latest.failure === "prepare_failed" ? "准备命令没过"
      : latest.failure === "entry_missing" ? "入口不在被测的树里" : "未通过";
    const handed = latest.handoff && !latest.handoff.error;
    return line("failed", `${what}，${handed ? "已交给任务修复" : latest.handoff ? "没叫醒任务" : "还没交给任务"}`,
      { run: latest, openLog: true, handOff: !handed });
  }
  return line("stopped", latest.status === "canceled" ? "已取消" : "被打断", { run: latest });
}

/**
 * 已验收那一行：**只认这一按自己的凭据**（basis），绝不拿「最近一次」反推 —— 命令在 A 上跑绿、
 * 代码改成 B、项目再撤掉命令，那时最近一次仍是那条绿的，而真正放行的理由是「那一刻没有门禁」。
 */
function receipt(state: AcceptGateState, latest: AcceptGateView | null, error: string | null): GateLine | null {
  const base = { command: null, run: null, openLog: false, stop: false, forceRelease: false, handOff: false, editable: false, retry: !!error };
  const basis = state.basis;
  const unconfirmed = error ? "，状态待核对" : "";
  if (basis?.mode === "passed") {
    return { ...base, tone: error ? "idle" : "passed", command: basis.run?.command ?? null,
      word: `${basis.run ? "通过" : "通过，记录已清理"}${unconfirmed}`, run: basis.run };
  }
  if (basis?.mode === "skipped") return { ...base, tone: error ? "idle" : "skipped", word: `已跳过${unconfirmed}` };
  // 那一刻没设、或老数据没留凭据：项目现在没命令、也没跑过的时候，这一行什么都不澄清，不出。
  if (!state.command && !latest) return null;
  return { ...base, tone: "idle", word: `${basis?.mode === "unset" ? "验收时没设" : "没留下验收凭据"}${unconfirmed}` };
}

/** 那份绿为什么不作数了。出路一样（再点验收会重跑），原因说错一种用户会去查错的地方。 */
function staleReason(state: AcceptGateState, latest: AcceptGateView): string {
  if (latest.command !== state.command) return "命令变了";
  if ((latest.prepareCommand ?? null) !== (state.prepare ?? null)) return "准备命令变了";
  const target = state.baselineTarget;
  if (state.baseline === "merge_preview" && target) {
    if (!latest.previewBase) return "基准换了";
    if (latest.previewBase !== target.commit) return "目标分支动了";
  }
  if (latest.previewBase && state.baseline !== "merge_preview") return "基准换了";
  return "代码变了";
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

/** 基准三档各自的效果，一句话（设置层里跟着当前那一档走）。 */
export function baselineEffect(mode: keyof typeof ACCEPT_GATE_BASELINE_LABELS, target: string | null, worktree: boolean): string {
  if (!worktree) return "这个任务在项目目录里干活，三档都只测分支自己";
  const t = target ?? "目标分支";
  if (mode === "contains_target") return `任务分支得先含有最新的 ${t}`;
  if (mode === "merge_preview") return `先把最新的 ${t} 合进来，测合并后的结果`;
  return "只测任务分支自己";
}

/** 监督方式只留名字（冒号前那一段），全文指上去看。 */
export function supervisionName(notice: string): string {
  return notice.split(/[：:]/)[0]!.trim() || notice;
}
