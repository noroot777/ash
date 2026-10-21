import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
    { directory: uploads },
  );
  assert.equal(markdown.length, 1);
  // 源文件的名字要留住:对话里那张卡片写的就是它(web attachmentView 剥掉 12 位前缀)。
  assert.match(basename(markdown[0]!), /^[A-Za-z0-9_-]{12}-local-screenshot\.png$/);
  assert.equal(persistMarkdownImages(`![重复](<${localImage}>)`, seen, { directory: uploads }).length, 0);
  assert.equal(persistMarkdownImages("![远程](https://example.com/image.png)", seen, { directory: uploads }).length, 0);

  // 相对路径按工作目录解析 —— agent 站在工作目录里写 `![](output/x.png)` 是最自然的
  // 写法,不认它那张图在对话里就只剩一个裂开的图标。
  mkdirSync(join(root, "output"), { recursive: true });
  const nested = join(root, "output", "shot.png");
  writeFileSync(nested, Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(8)]));
  const relative = persistMarkdownImages("![预览](output/shot.png)", seen, { directory: uploads, cwd: root });
  assert.equal(relative.length, 1);
  assert.match(basename(relative[0]!), /^[A-Za-z0-9_-]{12}-shot\.png$/);
  // 没有 cwd 就只认绝对路径(老行为),别拿相对路径去撞 server 自己的 cwd。
  assert.equal(persistMarkdownImages("![预览](output/shot.png)", new Set(), { directory: uploads }).length, 0);
  // 远程/内联 URL 不许被当成相对路径跟工作目录拼。
  assert.equal(
    persistMarkdownImages("![远程](https://example.com/image.png)", new Set(), { directory: uploads, cwd: root }).length,
    0,
  );

  console.log("Agent 图片附件持久化验证通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
