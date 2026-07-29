import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../src/Markdown";

const text = [
  "![第一张](/image-preview-one.png)",
  "",
  "![第二张](/image-preview-two.png)",
].join("\n");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main>
      <Markdown text={text} />
    </main>
  </StrictMode>,
);
