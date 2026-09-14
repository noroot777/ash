// 打开预览的现场，$PORT 到底教没教会（断言在 test-preview-port-guide.mjs）。
//
// 现场：新用户点「打开预览」，仓库里认不出候选，于是「自填启动命令」自动展开。他要在这儿
// 写下第一条命令 —— 而在这次改动之前，这儿关于端口只有一句「端口使用 ash 提供的 PORT
// 环境变量」。那句话读起来像「ash 会替你处理」，真实意思却是「你得把它写进命令」。
//
// 这里挂的是真组件（PreviewLaunchOptions），断言的是**新用户在这一屏里能不能不读文档就
// 写对**：判据看得见、起手式点一下就进输入框、方言跟着服务端那台机器走。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { PreviewPortDialect, PreviewServiceState, WorkspacePreviewLaunch } from "@ash/shared/preview";
import "../../src/styles/global.css";
import "../../src/styles/workspace.css";
import "../../src/preview-workspace/preview-workspace.css";
// 真实的加载点在 PreviewWorkspace.tsx（启动器只在它里面出现）；这里单挂 PreviewLaunchOptions，
// 所以得自己把这份样式带上，否则量出来的是一屏没上样式的裸 DOM。
import "../../src/preview-workspace/preview-launcher.css";
import { PreviewLaunchOptions } from "../../src/preview-workspace/PreviewLauncher.tsx";
import { PreviewPortDriftNotice } from "../../src/preview-workspace/PreviewPortDriftNotice.tsx";
import type { PreviewLaunchState } from "../../src/preview-workspace/previewLaunchController.ts";

// 认不出任何候选的仓库 —— 这正是自填框自动展开、用户非写不可的那一档。
const info: WorkspacePreviewLaunch = {
  kind: "free", reason: "", directory: "/task/worktree", steps: [], configured: null, truncated: false, candidates: [],
};
const state: PreviewLaunchState = { info, loading: false, action: null, error: "", notice: "" };

// 起好之后端口对不上的两档。这不是「再加一条提示」——它是运行时已经确知的事实，
// 所以摆在预览舞台顶上，而且命令写对时整块不渲染（下面第三条就是那一档）。
const ready = { status: "ready" as const, url: "http://localhost:5173/" };
const drifted: PreviewServiceState[] = [
  // 端口写在命令里 → 改写是确定的，敢把整行给用户抄走。
  { id: "pinned", name: "预览脚本", command: "npm run dev -- --port 5173", port: 5173, lentPort: 45843, ...ready },
];
const fromConfig: PreviewServiceState[] = [
  // 端口写在 vite.config.ts 里 → 编不出改法，就老实改口。
  { id: "config", name: "预览脚本", command: "npm run dev", port: 5173, lentPort: 45843, ...ready },
];
const obedient: PreviewServiceState[] = [
  { id: "ok", name: "预览脚本", command: "npm run dev -- --port $PORT", port: 45843, lentPort: 45843, ...ready, url: "http://localhost:45843/" },
];

function Fixture() {
  const [dialect, setDialect] = useState<PreviewPortDialect>("posix");
  const [services, setServices] = useState<PreviewServiceState[]>(drifted);
  return <div className="preview-workspace">
    <button type="button" data-testid="switch-dialect" onClick={() => setDialect(dialect === "posix" ? "cmd" : "posix")}>
      切到 {dialect === "posix" ? "Windows" : "POSIX"}
    </button>
    <button type="button" data-testid="services-pinned" onClick={() => setServices(drifted)}>端口写在命令里</button>
    <button type="button" data-testid="services-config" onClick={() => setServices(fromConfig)}>端口写在配置里</button>
    <button type="button" data-testid="services-ok" onClick={() => setServices(obedient)}>命令写对了</button>
    <div className="preview-workspace-stage">
      <PreviewPortDriftNotice services={services} dialect={dialect} />
    </div>
    <section className="preview-launcher" aria-label="启动页面预览">
      <PreviewLaunchOptions state={state} starting={false} stopped={false} dialect={dialect}
        onStart={() => {}} onCancel={() => {}} onRetry={() => {}} />
    </section>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
