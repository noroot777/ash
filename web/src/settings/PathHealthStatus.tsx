import { useEffect, useState } from "react";
import type { ProjectHealth } from "@ash/shared";
import { api } from "../lib/api.ts";

export type PathHealthState = {
  health: ProjectHealth | null;
  checking: boolean;
  failed: boolean;
};

/**
 * 同一条路径，三种问法：
 *  · `existing` —— 「这个已经存在的目录能不能当项目跑」。目录不存在是错，因为改项目路径
 *    这条路（PATCH /projects/:id）不会替你创建它。
 *  · `existing-or-new` —— 新建项目的本地目录。**不存在不是错**，提交时会连同缺失的上级
 *    一起建出来；除此之外的判定跟 `existing` 一模一样，所以直接复用它。
 *  · `clone-target` —— 「能不能往这里克隆」。**不存在才是最理想的情况**，反过来「已经是
 *    个仓库」才是错。判定完全相反，所以不能共用一句文案。
 */
export type PathHealthPurpose = "existing" | "existing-or-new" | "clone-target";

export type PathHealthVerdict = {
  text: string;
  tone: "good" | "bad" | "";
  /** 这条路径按当前问法根本走不通，调用方应该据此禁掉提交按钮。 */
  blocked: boolean;
};

/** 路径上是个文件时，三种问法给的都是同一句话：没有下一步，只能换一条路径。 */
const OCCUPIED: PathHealthVerdict = {
  text: "这条路径已经被一个文件占用了；换一条路径",
  tone: "bad",
  blocked: true,
};

function existingVerdict(health: ProjectHealth): PathHealthVerdict {
  if (health.occupied) return OCCUPIED;
  if (!health.exists) return { text: "目录不存在；Ash 不会自动创建它", tone: "bad", blocked: false };
  // 非 git 目录不是错，只是能力少一截 —— 而少的那一截（worktree 隔离）用户在新建任务时
  // 根本看不到开关，不在这里说清楚，他只会以为是自己没找到。
  if (!health.isRepo) {
    return { text: "目录存在，但不是 Git 仓库 —— 任务会直接在目录里跑，没有 worktree 隔离", tone: "", blocked: false };
  }
  const branch = health.branch ? ` · ${health.branch}` : "";
  // 有未提交修改不给绿灯：那不是错误，但也不是「随时可以开工」，留白比说好听话有用。
  return {
    text: `Git 仓库${branch} · ${health.dirty ? "有未提交修改" : "工作区干净"}`,
    tone: health.dirty ? "" : "good",
    blocked: false,
  };
}

function cloneTargetVerdict(health: ProjectHealth): PathHealthVerdict {
  if (health.occupied) return OCCUPIED;
  if (!health.exists) return { text: "目录还不存在，克隆时会连同上级目录一起建出来", tone: "good", blocked: false };
  if (health.isRepo) return { text: "这里已经是一个 Git 仓库了；换个目录名，或改用「本地目录」", tone: "bad", blocked: true };
  // `empty` 只有完整检查才带（/projects/check 走的正是它）；万一拿不到就别替服务端下
  // 结论，说清楚「由它判」而不是编一个可能相反的答案。
  if (health.empty === false) return { text: "目录已存在且不是空的；只有空目录才能克隆进去", tone: "bad", blocked: true };
  if (health.empty) return { text: "目录已存在且是空的，可以克隆进去", tone: "good", blocked: false };
  return { text: "目录已存在；能不能克隆进去由服务端在提交时判定", tone: "", blocked: false };
}

export function pathHealthVerdict(
  health: ProjectHealth | null,
  purpose: PathHealthPurpose = "existing",
): PathHealthVerdict {
  if (!health) return { text: "正在检查目录…", tone: "", blocked: false };
  if (purpose === "clone-target") return cloneTargetVerdict(health);
  // 目录会被建出来这件事，用户按下按钮之前就得知道 —— 按钮上那句「创建目录并创建项目」
  // 和这一句说的是同一件事，两处一起改。被文件占着的路径不在此列：它建不出来（见
  // `occupied`），走下面那条如实说被占了。
  if (purpose === "existing-or-new" && !health.exists && !health.occupied) {
    return { text: "目录还不存在，创建项目时会连同上级目录一起建出来", tone: "", blocked: false };
  }
  return existingVerdict(health);
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

/**
 * 「这条路径现在什么情况」。探测还没回来、探测失败都算**不拦**：路径检查是帮忙，不是
 * 门禁，服务端那边有真正的判定。
 */
export function pathHealthState(
  state: PathHealthState,
  path: string,
  purpose: PathHealthPurpose = "existing",
): PathHealthVerdict {
  if (!path.trim()) {
    return {
      text: purpose === "clone-target"
        ? "填好上面两项后会检查目标路径是否可用"
        : "填写目录后会检查是否存在、Git 状态和未提交修改",
      tone: "",
      blocked: false,
    };
  }
  if (state.checking) return { text: "正在检查目录…", tone: "", blocked: false };
  if (state.failed) return { text: "暂时无法检查目录；仍可尝试提交", tone: "", blocked: false };
  return pathHealthVerdict(state.health, purpose);
}

export function PathHealthStatus({
  path,
  state,
  purpose = "existing",
  className = "",
}: {
  path: string;
  state: PathHealthState;
  purpose?: PathHealthPurpose;
  className?: string;
}) {
  const verdict = pathHealthState(state, path, purpose);
  const tone = verdict.tone === "good" ? " is-good" : verdict.tone === "bad" ? " is-error" : "";
  return <div className={`settings-health${tone}${className ? ` ${className}` : ""}`} role="status"><i aria-hidden="true" />{verdict.text}</div>;
}
