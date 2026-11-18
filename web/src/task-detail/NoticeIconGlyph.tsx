import {
  Browser, ChatText, FolderOpen, GitBranch, GitMerge, Info, MagnifyingGlass, Pause, Pulse, Robot, Scales,
  ShieldCheck, Terminal, WarningCircle,
} from "@phosphor-icons/react";
import type { ReactElement } from "react";
import { WorkflowIcon } from "../components/WorkflowIcon.tsx";
import type { NoticeIcon } from "./noticePhrases.ts";

// 跟检查器里同一件事的那一格同一枚（taskInspectors：哨兵 Pulse、审查 MagnifyingGlass、预览指正
// Browser、工作流 WorkflowIcon、改动的分支一类走 git 那几枚）。
const GLYPHS: Record<NoticeIcon, (size: number) => ReactElement> = {
  monitor: (size) => <Pulse size={size} />,
  review: (size) => <MagnifyingGlass size={size} />,
  dispute: (size) => <Scales size={size} />,
  accept: (size) => <GitMerge size={size} />,
  gate: (size) => <ShieldCheck size={size} />,
  preview: (size) => <Browser size={size} />,
  workflow: (size) => <WorkflowIcon size={size} />,
  branch: (size) => <GitBranch size={size} />,
  workspace: (size) => <FolderOpen size={size} />,
  message: (size) => <ChatText size={size} />,
  executor: (size) => <Robot size={size} />,
  pause: (size) => <Pause size={size} />,
  command: (size) => <Terminal size={size} />,
  alert: (size) => <WarningCircle size={size} />,
  info: (size) => <Info size={size} />,
};

export function NoticeIconGlyph({ icon, size = 13 }: { icon: NoticeIcon; size?: number }) {
  return <span className="notice-icon" aria-hidden="true">{GLYPHS[icon](size)}</span>;
}
