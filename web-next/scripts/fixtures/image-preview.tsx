import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownBody } from "../../src/components/MarkdownBody.tsx";
import "../../src/styles/global.css";

const text = [
  "![第一张](/image-preview-one.png)",
  "",
  "![第二张](/image-preview-two.png)",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <MarkdownBody text={text} />
    </main>
  </StrictMode>,
);
