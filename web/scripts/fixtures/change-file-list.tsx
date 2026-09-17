import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GitFile, GitStatus } from "@ash/shared/git-workbench";
import { ChangeFileList, type ChangeSource } from "../../src/git-workbench/ChangeFileList.tsx";
import type { Workbench } from "../../src/git-workbench/useWorkbench.ts";
import "../../src/styles/global.css";
// 工作台那套皮肤是页面自己带的（`GitWorkbench.tsx` 里 import），夹具不带就只剩一堆裸标签。
import "../../src/styles/git-workbench.css";

// Git 工作台「更改」页左侧清单的夹具。清单被拆成纯展示组件之后，平铺/目录树这条交互不用
// 再拉起真后端 + 真仓库（那是 test-git-workbench.mjs 干的活）：喂一份 status 就能测。
//
// 写操作不真跑，只把「点了哪一颗、送上去的是哪几个路径」记到页面上，让用例断言。

const file = (path: string, kind = "modified", extra: Partial<GitFile> = {}): GitFile => ({
  path, kind, origPath: null, conflict: null, nested: false, additions: 3, deletions: 1, ...extra,
});

const status: GitStatus = {
  branch: { head: "main", oid: "abc1234", detached: false, upstream: null, ahead: null, behind: null },
  staged: [],
  unstaged: [
    file("server/src/chat/service.ts"),
    file("server/src/chat/context.ts"),
    file("server/scripts/test-chat.ts"),
    file("README.md"),
  ],
  untracked: [file("web/src/scm/draft.ts", "untracked")],
  merge: [],
  truncated: false,
  operation: null,
};

const workbench = { blocked: false, isBlocked: () => false } as unknown as Workbench;

function Fixture() {
  const [selection, setSelection] = useState<{ path: string; source: ChangeSource } | null>(null);
  const [action, setAction] = useState("");
  return (
    <div className="gwb gwb-design" style={{ width: 420, padding: 12 }}>
      <section className="gwb-file-pane changes-list" aria-label="工作区变更">
        <ChangeFileList
          status={status}
          workbench={workbench}
          selection={selection}
          onSelect={setSelection}
          onStage={(files, source) => setAction(`stage:${source}:${files.map((f) => f.path).join(",")}`)}
          onDiscard={(files, source) => setAction(`discard:${source}:${files.map((f) => f.path).join(",")}`)}
          onStash={() => setAction("stash")}
          onResolve={(path) => setAction(`resolve:${path}`)}
        />
      </section>
      <p id="action">{action}</p>
      <p id="selection">{selection ? `${selection.source}:${selection.path}` : ""}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
