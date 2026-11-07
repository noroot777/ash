import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TaskArtifact, type TaskArtifactsResult } from "../lib/api.ts";

// 产物面板的数据层。轮询而不是 SSE，理由跟 scm 面板一样：产物的来源是**任务目录里的
// 文件系统**，服务端并不知道 agent 什么时候落了一张图，没有事件可推。
//
// 比 scm 那边慢一档（8 秒）：这一趟要 fork 好几个 git 进程、还可能走一遍被忽略的目录，
// 而产物是「做完了看一眼」的东西，不像改动列表那样需要跟着 agent 的节奏跳。
// 面板没开的时候这个 hook 根本没挂载（InspectorHost 只渲染当前那一格），所以不必另做开关。
const POLL_MS = 8000;

export type ArtifactGroup = { key: string; label: string; items: TaskArtifact[] };

const KIND_ORDER: TaskArtifact["kind"][] = ["image", "page", "doc", "video", "audio", "pdf"];

export const ARTIFACT_KIND_LABEL: Record<TaskArtifact["kind"], string> = {
  image: "图片",
  page: "网页",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  doc: "文档",
};

export const ARTIFACT_ORIGIN_LABEL: Record<TaskArtifact["origin"], string> = {
  working: "未提交",
  committed: "已提交",
  ignored: "未纳入版本管理",
};

/** 角标的悬浮解释——「未提交」三个字本身说不清它凭什么算这个任务的产物。 */
export const ARTIFACT_ORIGIN_HINT: Record<TaskArtifact["origin"], string> = {
  working: "还在工作目录里，没有提交",
  // 共享主仓的任务（useWorktree=false）压根没有一条属于它的分支，那一档退回「运行区间
  // 里的提交」——两种认法的精度不同，角标上不说清楚就会被当成同一回事。
  committed: "已经提交：有任务分支时按那条分支认，共享主仓的任务按运行区间里的提交认",
  ignored: "被 .gitignore 挡着，不在版本管理里",
};

/**
 * 候选那一档：默认折起来，收在「拿不准归属的」那一栏，逐条说为什么拿不准。
 *
 * 确定的不加角标——那是多数，标了只是噪音；真正需要被认出来的是混进来的那几个。拿不准的也不
 * 混在确定的中间：共享目录上两个任务同时在跑时，候选可能有几百个，摊开就把它真正做出来的
 * 东西淹了（原需求抱怨的正是这个）。
 */
export const ARTIFACT_CONFIDENCE_LABEL = "候选";
export const ARTIFACT_DOUBTFUL_HEAD = "拿不准归属的";

export const ARTIFACT_DOUBT_LABEL: Record<NonNullable<TaskArtifact["doubt"]>, string> = {
  estimated: "时间是估的",
  concurrent: "同时有别的任务在跑",
  timed: "只按时间认的",
  version: "后来被改过",
  contested: "别人写过同样内容",
};

export const ARTIFACT_DOUBT_HINT: Record<NonNullable<TaskArtifact["doubt"]>, string> = {
  estimated: "只落在估出来的时间段里（会话寿命、没收尾的回合），可能是别人在同一个目录里做的",
  concurrent: "做出来的那一刻还有别的任务在跑；别的任务就算不在这个目录，也能用命令把文件写进来，分不出是谁做的",
  timed: "不是它亲手写下的（多半是命令生成的），共用目录时只能按时间认，证明不了是它做的",
  version: "它动过这个文件，但现在这份已经不是它那一版，可能被别人改过",
  contested: "它和别的任务写下过一模一样的内容，证明不了是谁的",
};

/** 老服务端没给 `doubt` 的候选，按最早那一种（估出来的时间段）解释。 */
export const doubtOf = (artifact: TaskArtifact) => artifact.doubt ?? "estimated";

/** 拿不准的那些里，同一时间也在跑的任务（去重、按出现次数从多到少）。 */
export function alongsideOf(artifacts: readonly TaskArtifact[]): string[] {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    for (const title of artifact.alongside ?? []) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([title]) => title);
}

/**
 * 整份清单**凭什么算这个任务的**。
 *
 * 两档的精度差一个数量级，不能让用户自己猜：独占 worktree 是目录级隔离，清单是确定的；
 * 共享主仓只能按「它在跑的那几段时间」认，同一段时间里并行跑的任务物理上分不开，那是
 * **候选**。界面不说这一句，用户就会把候选当确定（第 1 轮审查 N6）。
 */
export const ARTIFACT_SCOPE_NOTE: Record<TaskArtifactsResult["scope"], string | null> = {
  exclusive: null, // 独占目录：不必解释，清单就是它做的
  shared: "这个任务和别人共用一个工作目录：上面那些有直接证据，拿不准的都收在「拿不准归属的」那一栏。",
};

export function groupArtifacts(artifacts: readonly TaskArtifact[]): ArtifactGroup[] {
  const byKind = new Map<TaskArtifact["kind"], TaskArtifact[]>();
  for (const artifact of artifacts) {
    const list = byKind.get(artifact.kind);
    if (list) list.push(artifact);
    else byKind.set(artifact.kind, [artifact]);
  }
  return KIND_ORDER
    .filter((kind) => byKind.has(kind))
    .map((kind) => ({ key: kind, label: ARTIFACT_KIND_LABEL[kind], items: byKind.get(kind)! }));
}

export function formatArtifactTime(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const minutes = Math.floor((Date.now() - at.getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前`;
  return at.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function useTaskArtifacts(taskId: string) {
  const [result, setResult] = useState<TaskArtifactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 首次加载和之后每一轮轮询要分开：轮询时把列表清空换成「正在读取」，面板会一下一下地闪。
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await api.taskArtifacts(taskId);
      if (epoch !== generation.current) return;
      // 字段在这儿补齐默认值：这两个是后加的，而前端是单独构建、单独刷新的——页面已经是
      // 新版、服务端还没重启的那个窗口里，旧响应里没有 `incomplete`，渲染时 `.map` 直接
      // 把整块炸掉（第 2 轮审查 N3）。补默认比在每个用到的地方各写一次 `?? []` 可靠。
      setResult({ ...next, scope: next.scope ?? "shared", incomplete: next.incomplete ?? [] });
      setError(null);
    } catch (reason) {
      if (epoch !== generation.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setResult(null);
    setError(null);
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || running) return;
      running = true;
      try { await load(); } finally { running = false; }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  return { result, error, loading, refresh: load };
}
