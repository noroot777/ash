// 文内锚点的 DOM fixture（见 components/markdownAnchors.ts）。
//
//   ① 一份文档里的目录链接：中文标题、带标点的英文标题、重名标题（`#结论-1`）、大小写不一致、
//      GitHub 前缀加大写、回到顶部（空片段 `#`）、名字撞上脚注 id 的标题；
//   ② 会话里两条消息各有一条 `[^1]` 脚注、同名标题 —— 点第二条里的，只能跳到第二条自己那里；
//   ③ 对话正文里的 `docs/other.md#第二节`：在右侧查看器里打开并滚到那一节；同一份文件再点
//      另一节不重读、直接滚；`#L3` 行号后缀照旧只是打开整份文件。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownBody } from "../../src/components/MarkdownBody.tsx";
import { TaskFileLinks } from "../../src/components/TaskFileLink.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import { useFileView } from "../../src/files/useFileView.ts";
import "../../src/styles/global.css";

const filler = (label: string, count = 14) =>
  Array.from({ length: count }, (_, index) => `${label}的第 ${index + 1} 段填充文字，用来把下一节推到滚动容器外面。`).join("\n\n");

const DOCUMENT = [
  "# 方案文档",
  "",
  "- [实现方案](#实现方案)",
  "- [Hello World!](#hello-world)",
  "- [第二个结论](#结论-1)",
  "- [大小写不一致](#Hello-World)",
  "- [不存在的一节](#没有这一节)",
  "- [GitHub 抄来的](#user-content-Hello-World)",
  "",
  "名字撞上脚注 id 的标题在下面，脚注角标在这里[^1]。",
  "",
  "## user-content-fn-1",
  "",
  filler("撞名标题", 4),
  "",
  "## 结论",
  "",
  filler("第一个结论"),
  "",
  "## 实现方案",
  "",
  filler("实现方案"),
  "",
  "## Hello, World!",
  "",
  filler("Hello"),
  "",
  "## 结论",
  "",
  filler("第二个结论"),
  "",
  "[回到顶部](#)",
  "",
  "[^1]: 文档里的脚注正文。",
].join("\n");

const message = (name: string) => [
  `## 小结`,
  "",
  `${name}的说法见脚注[^1]。`,
  "",
  filler(name, 10),
  "",
  `[^1]: ${name}的脚注正文。`,
].join("\n");

const CONVERSATION_LINKS = [
  "方案见 [第二节](docs/other.md#第二节)，",
  "同一份的 [第三节](docs/other.md#%E7%AC%AC%E4%B8%89%E8%8A%82)，",
  "回到 [文件开头](docs/other.md#)，",
  "以及 [第 3 行](docs/plain.md#L3)。",
].join("");

function CrossFile() {
  const fileView = useFileView("T1");
  return (
    <TaskFileLinks taskId="T1" onOpenFile={fileView.openFileAt} onOpenFolder={fileView.openFolder} onOpenError={() => {}}>
      <div className="cross-fixture" style={{ display: "flex", gap: 16 }}>
        <div className="cross-conversation" style={{ width: 360 }}>
          <MarkdownBody text={CONVERSATION_LINKS} />
        </div>
        <div className="cross-pane" style={{ display: "flex", width: 520, height: 420 }}>
          {fileView.filePath && (
            <FileViewer
              taskId="T1"
              path={fileView.filePath}
              anchor={fileView.anchor}
              onClose={fileView.close}
              notify={() => {}}
            />
          )}
        </div>
      </div>
    </TaskFileLinks>
  );
}

const scroller = { height: 320, overflow: "auto", border: "1px solid #ddd", padding: "0 12px" } as const;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 底部留白：文末的脚注要滚得到容器上沿。 */}
    <div className="doc-fixture" style={{ ...scroller, paddingBottom: 400 }}>
      <MarkdownBody text={DOCUMENT} />
    </div>
    <div className="conversation-fixture" style={scroller}>
      <div className="message-1"><MarkdownBody text={message("第一条消息")} /></div>
      <div className="message-2"><MarkdownBody text={message("第二条消息")} /></div>
      {/* 末尾留白：最后那条脚注在内容最底下，没有它容器滚不到让它贴顶的位置。 */}
      <div style={{ height: 400 }} />
    </div>
    <CrossFile />
  </StrictMode>,
);
