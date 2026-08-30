import type { ReactNode } from "react";
import { ArrowsLeftRight, GitBranch, ShieldCheck } from "@phosphor-icons/react";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-stage">
        <aside className="auth-brand">
          <div className="auth-brand-mark" aria-label="ash">a</div>
          <div className="auth-brand-copy">
            <span>LOCAL AGENT OPERATIONS</span>
            <h2>把复杂的协作，留在一张清楚的工作台里。</h2>
            <p>项目、智能体、权限和接力都在本机编排，重要状态始终有迹可循。</p>
          </div>
          <ul className="auth-brand-points">
            <li><GitBranch size={17} weight="duotone" /><span><b>隔离执行</b><small>每项任务拥有独立工作区</small></span></li>
            <li><ArrowsLeftRight size={17} weight="duotone" /><span><b>顺滑接力</b><small>上下文与进度一起移动</small></span></li>
            <li><ShieldCheck size={17} weight="duotone" /><span><b>身份明确</b><small>多人协作保留清晰边界</small></span></li>
          </ul>
          <p className="auth-brand-foot">ASH · AGENT CONTROL ROOM</p>
        </aside>
        <main className="auth-stage-content">{children}</main>
      </div>
    </div>
  );
}
