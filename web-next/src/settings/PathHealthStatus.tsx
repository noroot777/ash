import { useEffect, useState } from "react";
import type { ProjectHealth } from "@harness/shared";
import { api } from "../lib/api.ts";

export type PathHealthState = {
  health: ProjectHealth | null;
  checking: boolean;
  failed: boolean;
};

export function pathHealthText(health: ProjectHealth | null): string {
  if (!health) return "正在检查目录…";
  if (!health.exists) return "目录不存在；Harness 不会自动创建它";
  if (!health.isRepo) return "目录存在，但不是 Git 仓库";
  return `Git 仓库${health.branch ? ` · ${health.branch}` : ""}${health.dirty ? " · 有未提交修改" : " · 工作区干净"}`;
}

export function useDebouncedPathHealth(path: string, delay = 350): PathHealthState {
  const normalized = path.trim();
  const [state, setState] = useState<PathHealthState>({ health: null, checking: false, failed: false });
  useEffect(() => {
    if (!normalized) {
      setState({ health: null, checking: false, failed: false });
      return;
    }
    let alive = true;
    setState({ health: null, checking: true, failed: false });
    const timer = window.setTimeout(() => {
      api.checkPath(normalized)
        .then((health) => { if (alive) setState({ health, checking: false, failed: false }); })
        .catch(() => { if (alive) setState({ health: null, checking: false, failed: true }); });
    }, delay);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [delay, normalized]);
  return state;
}

export function PathHealthStatus({
  path,
  state,
  className = "",
}: {
  path: string;
  state: PathHealthState;
  className?: string;
}) {
  const normalized = path.trim();
  const tone = state.health?.exists && state.health.isRepo && !state.health.dirty
    ? " is-good"
    : state.health && !state.health.exists
      ? " is-error"
      : "";
  const text = !normalized
    ? "填写目录后会检查是否存在、Git 状态和未提交修改"
    : state.checking
      ? "正在检查目录…"
      : state.failed
        ? "暂时无法检查目录；仍可尝试提交"
        : pathHealthText(state.health);
  return <div className={`settings-health${tone}${className ? ` ${className}` : ""}`} role="status"><i aria-hidden="true" />{text}</div>;
}
