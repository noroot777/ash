import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewGroup } from "../../src/components/ImagePreview.tsx";
import { InspectorPromptContent } from "../../src/task-detail/InspectorPromptContent.tsx";
import "../../src/styles/global.css";

const original = [
  "检查原始需求里的图片链接。",
  "",
  "[用户附带的文件，请用 Read 工具查看以下本地文件]",
  "- /Users/fjh/code/harness/data/uploads/KxOxbl42hcRf-image.png",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="task-inspector" style={{ width: 360, height: 420 }}>
      <div className="task-inspector-scroll">
        <ImagePreviewGroup isolated>
          <section>
            <details open>
              <summary>原始需求</summary>
              <InspectorPromptContent text={original} emptyText="这个任务没有正文说明。" />
            </details>
            <details className="task-inspector-follow-ups" open>
              <summary>后续追问</summary>
              <ol>
                <li>
                  <InspectorPromptContent
                    text="检查追问里的图片链接。"
                    attachments={[
                      "/Users/fjh/code/harness/data/uploads/R4nd0mAbC123-follow-up.jpg",
                      "/Users/fjh/code/harness/data/uploads/D0cumentAb12-spec.pdf",
                    ]}
                    emptyText="（空消息）"
                  />
                </li>
              </ol>
            </details>
          </section>
        </ImagePreviewGroup>
      </div>
    </main>
  </StrictMode>,
);
