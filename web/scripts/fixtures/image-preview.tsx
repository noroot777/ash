import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LeftDrawerProvider, useLeftDrawerHost } from "../../src/components/LeftDrawer.tsx";
import { MarkdownBody } from "../../src/components/MarkdownBody.tsx";
import "../../src/styles/global.css";

const inline = [
  "![第一张](/image-preview-one.png)",
  "",
  "![第二张](/image-preview-two.png)",
].join("\n");

// 第二块是「链接指向图片」那一路：agent 在对话里写的证据链接（截图落在验证证据目录、
// 用户贴的附件落在 data/uploads）必须跟内嵌图编进同一组灯箱；报告 .md 和站外图不接管。
const links = [
  "证据：[报告](/Users/example/code/navi/data/runs/tsk1234/review/round-1/report.md)"
  + " · [截图](/Users/example/code/navi/data/runs/tsk1234/review/round-1/image-preview-two.png)",
  "",
  "![内嵌](/image-preview-one.png)",
  "",
  "[附件](/Users/example/code/navi/data/uploads/AbCdEfGh1234-image-preview-one.png)",
  "",
  "[证据接口图](/api/tasks/tsk1234/review/file?round=2&name=image-preview-one.png)",
  "",
  "自由审查：[自由报告](/Users/example/code/navi/data/runs/tsk1234/free-review/run-abc/round-1/report.md)"
  + " · [自由截图](/Users/example/code/navi/data/runs/tsk1234/free-review/run-abc/round-1/image-preview-two.png)",
  "",
  "[自由证据接口图](/api/tasks/tsk1234/free-workflow/review-file?run=run-abc&round=1&name=image-preview-one.png)",
  "",
  "[本地 Demo](/Users/example/code/navi/.worktrees/demo/docs/baseline/index.html)",
  "",
  "[普通本地文件](/Users/example/Documents/demo.html)",
  "",
  "[站外图](https://example.com/remote.png)",
].join("\n");

// 没有左侧抽屉的地方（随手记、助手）：报告 .md 不接管，照普通链接另开标签页。
const orphan = "[孤立报告](/Users/example/code/navi/data/runs/tsk1234/review/round-1/report.md)";

// 前两块照 TaskDetail 的做法挂在左侧抽屉的宿主里：正文里点到报告 .md 从左边推出读全文那一屉。
function Fixture() {
  const drawer = useLeftDrawerHost({ resetKey: "demo" });
  return (
    <main>
      <LeftDrawerProvider value={drawer.api}>
        <div id="drawer-host" style={{ position: "relative" }}>
          <section id="inline">
            <MarkdownBody text={inline} />
          </section>
          <section id="links">
            <MarkdownBody text={links} />
          </section>
          {drawer.drawer}
        </div>
      </LeftDrawerProvider>
      <section id="no-drawer">
        <MarkdownBody text={orphan} />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
