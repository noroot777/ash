import type { GitView } from "@ash/shared/git-workbench";

const shapes = {
  changes: <><path d="M3 5.5h7M3 8h10M3 10.5h6" /><circle cx="12.5" cy="5.5" r="1.6" /></>,
  history: <><circle cx="8" cy="8" r="5.6" /><path d="M8 5v3.2l2.2 1.4" /></>,
  branches: <><circle cx="4.5" cy="4" r="1.7" /><circle cx="4.5" cy="12" r="1.7" /><circle cx="11.5" cy="6.5" r="1.7" /><path d="M4.5 5.7v4.6M11.5 8.2c0 2.6-4 1.6-6.2 3" /></>,
  stash: <><path d="M2.5 6.5 8 3.5l5.5 3L8 9.5z" /><path d="M2.5 9.5 8 12.5l5.5-3" /></>,
  tags: <><path d="M8.6 2.5H13v4.4l-6 6a1.2 1.2 0 0 1-1.7 0L2.6 10a1.2 1.2 0 0 1 0-1.7z" /><circle cx="10.6" cy="5" r="1" fill="currentColor" stroke="none" /></>,
  worktrees: <><rect x="2.5" y="2.5" width="4.6" height="11" rx="1" /><rect x="9" y="2.5" width="4.6" height="5" rx="1" /><rect x="9" y="9.5" width="4.6" height="4" rx="1" /></>,
  log: <><path d="M3 3.5h10M3 8h10M3 12.5h6.5" /><circle cx="12.5" cy="12.5" r="1.4" /></>,
};

export function WorkbenchNavIcon({ view }: { view: GitView }) {
  return <svg className="ic" width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[view]}</svg>;
}
