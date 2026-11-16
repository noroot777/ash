import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewGroup } from "../../src/components/ImagePreview.tsx";
import { InspKv } from "../../src/inspector/parts.tsx";
import { InfoFollowUps } from "../../src/task-detail/info/InfoAsk.tsx";
import "../../src/styles/global.css";

// 「信息」格里的追问列表（真组件）。原始需求不在这一格，它是会话流里的第一颗气泡。
const followUps = [
  {
    text: [
      "检查第一条追问里的图片链接。",
      "",
      "[用户附带的文件，请用 Read 工具查看以下本地文件]",
      "- /Users/example/code/ash/data/uploads/KxOxbl42hcRf-image.png",
    ].join("\n"),
    attachments: [],
    at: "2026-11-13T02:00:00.000Z",
  },
  {
    text: "检查第二条追问里的图片链接。",
    attachments: [
      "/Users/example/code/ash/data/uploads/R4nd0mAbC123-follow-up.jpg",
      "/Users/example/code/ash/data/uploads/D0cumentAb12-spec.pdf",
    ],
    at: "2026-11-13T02:05:00.000Z",
  },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ width: 360, height: 420 }}>
      <ImagePreviewGroup isolated>
        <InspKv label="我说过的话">
          <InfoFollowUps followUps={followUps} />
        </InspKv>
      </ImagePreviewGroup>
    </main>
  </StrictMode>,
);
