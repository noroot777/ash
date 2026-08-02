import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ImagePreviewGroup, PreviewableImage } from "../../src/components/ImagePreview.tsx";
import "../../src/styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <ImagePreviewGroup>
        <PreviewableImage src="/image-preview-one.png" alt="第一张" />
        <PreviewableImage src="/image-preview-two.png" alt="第二张" />
      </ImagePreviewGroup>
    </main>
  </StrictMode>,
);
