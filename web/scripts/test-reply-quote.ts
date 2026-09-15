import assert from "node:assert/strict";
import { appendReplyQuote } from "../src/task-detail/replyQuote.ts";

// 选文点「添加到对话」写进草稿的那一段文本。光标要落在引用**下面**，所以末尾恒留一个空行。
assert.equal(appendReplyQuote("", "选中的一句话"), "> 选中的一句话\n\n");
assert.equal(appendReplyQuote("", "第一行\n第二行"), "> 第一行\n> 第二行\n\n", "每一行都带引用标记");
assert.equal(appendReplyQuote("", "带尾巴的一句话\n\n"), "> 带尾巴的一句话\n\n", "选区末尾的空行不变成空引用行");
assert.equal(appendReplyQuote("", "第一行\r\n第二行"), "> 第一行\n> 第二行\n\n", "CRLF 也按行拆");
assert.equal(appendReplyQuote("已经写了一半", "选文"), "已经写了一半\n\n> 选文\n\n", "已有草稿留在前面，空一行隔开");
assert.equal(appendReplyQuote("已经写了一半\n\n", "选文"), "已经写了一半\n\n> 选文\n\n", "草稿自带空行也只空一行");
assert.equal(appendReplyQuote("> 上一段\n\n", "再选一段"), "> 上一段\n\n> 再选一段\n\n", "连选两段各自成块");
console.log("✓ 选文写进对话框：逐行引用、接在已有草稿后面、末尾留出光标落点");
