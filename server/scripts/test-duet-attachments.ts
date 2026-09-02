// 讨论附件链路的回归钉子,两处成稿共一套规矩:
//   · 收敛门 GateAction.attachments → 讨论者 prompt / 时间线气泡
//   · 新建面板的附件 → duet.topic → 开场 prompt 的「议题」
// 读端(shared 的 parseAttachmentText)必须能把这两段文本原样拆回来 —— 两端逐字对不上,
// 界面上就是「用户发了图,气泡里只有一串本地路径」。
//
// 末尾那段走真的 POST /tasks:成稿函数写对了、建任务时忘了调它,前面的断言一条都不会红。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { parseAttachmentText } from "@ash/shared/attachments";
import { duetTopicText, gateUserMessage } from "../src/duet/user-message.js";

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

// ── 议题侧 ────────────────────────────────────────────────────────────────
// 新建面板贴的图必须进 duet.topic:直接创建的讨论只读 topic、不读 task.body
// (duet/index.ts `loadBase`),议题里没有它就等于用户白贴。
const topic = duetTopicText("这两版首页哪个更好", ["/tmp/uploads/v1-image.png", "/tmp/uploads/v2-image.png"]);
const parsedTopic = parseAttachmentText(topic);
assert.equal(parsedTopic.body, "这两版首页哪个更好");
assert.deepEqual(parsedTopic.paths, ["/tmp/uploads/v1-image.png", "/tmp/uploads/v2-image.png"]);

// 只贴图不打字就创建讨论:议题同样要有兜底句,否则开场 prompt 里「议题：」后面是空的。
const topicOnlyFiles = parseAttachmentText(duetTopicText("  ", ["/tmp/uploads/d-image.png"]));
assert.equal(topicOnlyFiles.body, "请看我附上的文件/截图。");
assert.deepEqual(topicOnlyFiles.paths, ["/tmp/uploads/d-image.png"]);

// 没附件的讨论一个字都不多加(存量讨论的 topic 逐字不变)。
assert.equal(duetTopicText("为什么选 B 方案"), "为什么选 B 方案");
assert.equal(duetTopicText("  为什么选 B 方案  ", []), "为什么选 B 方案");

// ── 端到端:建一个带附件的讨论 ──────────────────────────────────────────────
// 新建面板送的是 body + duet.topic + attachments 三样,附件块要**分别**落在 body 和
// topic 末尾:topic 喂开场 prompt(loadBase 只认它),body 喂详情页顶部的「完整议题」。
const root = mkdtempSync(join(tmpdir(), "ash-duet-attachments-"));
process.env.ASH_DB = join(root, "ash.db");

const [{ db, ensureSchema }, schema, { mountTaskRoutes }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-routes.js"),
]);

try {
  await ensureSchema();
  await db.insert(schema.projects).values({
    id: "project",
    name: "duet attachments",
    repoPath: root,
    apiKeys: null,
    createdAt: new Date().toISOString(),
  });

  const api = new Hono();
  mountTaskRoutes(api);
  const paths = ["/tmp/uploads/e-image.png", "/tmp/uploads/f.pdf"];
  const response = await api.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "project",
      title: "这两版首页哪个更好",
      mode: "duet",
      body: "这两版首页哪个更好",
      attachments: paths,
      useWorktree: false,
      duet: { topic: "这两版首页哪个更好", style: "duet", voiceA: "claude", voiceB: "codex" },
    }),
  });
  assert.equal(response.status, 201, "创建带附件的讨论应当成功");

  const created = (await response.json()) as { id: string };
  const row = (await db.select().from(schema.tasks).where(eq(schema.tasks.id, created.id))).at(0);
  assert.ok(row, "任务应当落库");

  const stored = parseAttachmentText(JSON.parse(row!.duet!).topic as string);
  assert.equal(stored.body, "这两版首页哪个更好", "议题正文原样保留");
  assert.deepEqual(stored.paths, paths, "议题末尾要带上附件路径,否则讨论者读不到用户贴的图");

  const shown = parseAttachmentText(row!.body);
  assert.equal(shown.body, "这两版首页哪个更好");
  assert.deepEqual(shown.paths, paths, "详情页顶部的「完整议题」读的是 body,同样要有");

  console.log("duet attachments ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}