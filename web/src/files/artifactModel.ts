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

const KIND_ORDER: TaskArtifact["kind"][] = ["image", "page", "video", "audio", "pdf"];

export const ARTIFACT_KIND_LABEL: Record<TaskArtifact["kind"], string> = {
  image: "图片",
  page: "网页",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
};

export const ARTIFACT_ORIGIN_LABEL: Record<TaskArtifact["origin"], string> = {
  working: "未提交",
  committed: "已提交",
  ignored: "未纳入版本管理",
};

/** 角标的悬浮解释——「未提交」三个字本身说不清它凭什么算这个任务的产物。 */
export const ARTIFACT_ORIGIN_HINT: Record<TaskArtifact["origin"], string> = {
  working: "还在工作目录里，没有提交",
  committed: "已经提交在这条任务分支上",
  ignored: "被 .gitignore 挡着，按「任务开跑之后才写的」认出来",
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
      setResult(next);
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
