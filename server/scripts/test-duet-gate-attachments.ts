// 收敛门附件链路的回归钉子:GateAction.attachments → 讨论者 prompt / 时间线气泡 的成稿。
// 读端(shared 的 parseAttachmentText)必须能把这段文本原样拆回来 —— 两端逐字对不上,
// 界面上就是「用户发了图,气泡里只有一串本地路径」。
import assert from "node:assert/strict";
import { parseAttachmentText } from "@ash/shared/attachments";
import { gateUserMessage } from "../src/duet/user-message.js";

// 一句话 + 一张截图:正文在前,附件段在后。
const withBoth = gateUserMessage("这里的按钮点不动", ["/tmp/uploads/a-image.png"]);
assert.match(withBoth, /^这里的按钮点不动\n\n\[用户附带的文件/);
assert.ok(withBoth.includes("- /tmp/uploads/a-image.png"));
const parsedBoth = parseAttachmentText(withBoth);
assert.equal(parsedBoth.body, "这里的按钮点不动");
assert.deepEqual(parsedBoth.paths, ["/tmp/uploads/a-image.png"]);

// 只贴图不打字:必须有兜底句,否则 prompt 末尾只剩路径,讨论者不知道要拿它们干什么。
const onlyFiles = gateUserMessage("   ", ["/tmp/uploads/b-image.png", "/tmp/uploads/c.pdf"]);
const parsedFiles = parseAttachmentText(onlyFiles);
assert.equal(parsedFiles.body, "请看我附上的文件/截图。");
assert.deepEqual(parsedFiles.paths, ["/tmp/uploads/b-image.png", "/tmp/uploads/c.pdf"]);

// 没有附件时一个字都不多加(旧讨论的注入/提问原样不变)。
assert.equal(gateUserMessage("  为什么选 B 方案  "), "为什么选 B 方案");
assert.equal(gateUserMessage("为什么选 B 方案", []), "为什么选 B 方案");
assert.equal(gateUserMessage("", []), "");

console.log("duet gate attachments ok");
