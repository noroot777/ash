import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistMarkdownImages,
  persistToolResultImages,
} from "../src/agent-attachments.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GENERATED_BASE64 = Buffer.concat([
  Buffer.from(PNG_BASE64, "base64"),
  Buffer.alloc(64),
]).toString("base64");
const root = mkdtempSync(join(tmpdir(), "ash-agent-attachments-"));
const uploads = join(root, "data", "uploads");
const localImage = join(root, "local screenshot.png");

try {
  writeFileSync(localImage, Buffer.from(PNG_BASE64, "base64"));

  const mcp = persistToolResultImages({
    content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
  }, new Set(), { directory: uploads });
  assert.equal(mcp.length, 1);
  assert.deepEqual(readFileSync(mcp[0]!), Buffer.from(PNG_BASE64, "base64"));

  const claude = persistToolResultImages({
    content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
    }],
  }, new Set(), { directory: uploads });
  assert.equal(claude.length, 1);

  const generated = persistToolResultImages(GENERATED_BASE64, new Set(), {
    allowBareBase64: true,
    directory: uploads,
  });
  assert.equal(generated.length, 1);
  const generatedDataUrl = persistToolResultImages({
    image_url: `data:image/png;base64,${PNG_BASE64}`,
  }, new Set(), { allowBareBase64: true, directory: uploads });
  assert.equal(generatedDataUrl.length, 1);

  const seen = new Set<string>();
  const markdown = persistMarkdownImages(
    `截图：![CLI](<${localImage}>)`,
    seen,
    uploads,
  );
  assert.equal(markdown.length, 1);
  assert.equal(persistMarkdownImages(`![重复](<${localImage}>)`, seen, uploads).length, 0);
  assert.equal(persistMarkdownImages("![远程](https://example.com/image.png)", seen, uploads).length, 0);

  console.log("Agent 图片附件持久化验证通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
