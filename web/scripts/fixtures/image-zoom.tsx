import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewableImage } from "../../src/components/ImagePreview.tsx";
import { FileViewer } from "../../src/files/FileViewer.tsx";
import "../../src/styles/global.css";

// 两条看图路径各摆一份：对话里的缩略图（点开是灯箱）和文件树/生成物点开的中栏查看器。
// 图都比容器大，「适应」时的读数不到 100%——小图夹具测不出「实际大小」那一档；「略大图」
// 只比灯箱宽出几个像素，适应时读数 99%，专钉「被缩小过就该切到 100%」。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main style={{ display: "flex", gap: 16, height: "100vh" }}>
      <section id="thumb" style={{ width: 160 }}>
        <PreviewableImage src="/image-zoom-large.svg" alt="大图" style={{ width: 120 }} />
        <PreviewableImage src="/image-zoom-near.svg" alt="略大图" style={{ width: 120 }} />
      </section>
      <section id="viewer" style={{ display: "flex", width: 720, height: 520 }}>
        <FileViewer taskId="demo" path="shots/large.png" onToggleZoom={() => {}} onClose={() => {}} notify={() => {}} />
      </section>
    </main>
  </StrictMode>,
);
