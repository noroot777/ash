import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
  "证据：[报告](/Users/fjh/code/harness/data/runs/tsk1234/review/round-1/report.md)"
  + " · [截图](/Users/fjh/code/harness/data/runs/tsk1234/review/round-1/image-preview-two.png)",
  "",
  "![内嵌](/image-preview-one.png)",
  "",
  "[附件](/Users/fjh/code/harness/data/uploads/AbCdEfGh1234-image-preview-one.png)",
  "",
  "[站外图](https://example.com/remote.png)",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <section id="inline">
        <MarkdownBody text={inline} />
      </section>
      <section id="links">
        <MarkdownBody text={links} />
      </section>
    </main>
  </StrictMode>,
);
