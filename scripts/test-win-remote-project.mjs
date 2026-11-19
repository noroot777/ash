// win-remote 选对端项目：没指定时按目录名认本仓库（新旧名都认），认不出、认出好几个都拒绝，
// 绝不退到列表第一项 —— 选错了，同步和执行会在别人的仓库里干活，且不报错。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LEGACY_REPO_DIR_NAMES } from "./legacy-names.mjs";

delete process.env.WIN_REMOTE_PROJECT;
delete process.env.WIN_REMOTE_KEY;
const { resolveProject } = await import("./win-remote/transport.mjs");

let projects = [];
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/api/projects" ? projects : {}));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const host = `http://127.0.0.1:${server.address().port}`;
const pick = async (list) => { projects = list; return resolveProject(host); };

const OLD = LEGACY_REPO_DIR_NAMES[0];
const notes = { id: "notes", repoPath: "D:\\projects\\notes" };
const oldCheckout = { id: "self", repoPath: `D:\\ai_workspace\\${OLD}` };
try {
  assert.deepEqual(await pick([notes, oldCheckout]), oldCheckout, "别的项目排在前面、本仓库还是旧目录名：照样认出本仓库");
  const fresh = { id: "fresh", repoPath: "C:\\code\\navi" };
  assert.deepEqual(await pick([notes, fresh]), fresh, "新目录名");
  const unix = { id: "unix", repoPath: `/home/u/code/${LEGACY_REPO_DIR_NAMES[1]}/` };
  assert.deepEqual(await pick([notes, unix]), unix, "正斜杠、结尾带斜杠的路径按最后一段认");

  const lookalike = { id: "nav", repoPath: "D:\\code\\navigation" };
  await assert.rejects(pick([notes, lookalike]), (e) => /认不出/.test(e.message) && /notes/.test(e.message) && /nav/.test(e.message),
    "名字里带着 navi 不算：认不出就拒绝并列出全部，不退到第一项");
  await assert.rejects(pick([notes, oldCheckout, fresh]), /好几个/, "认出两个就拒绝，不替人挑");

  process.env.WIN_REMOTE_PROJECT = "notes";
  assert.deepEqual(await pick([notes, oldCheckout]), notes, "明确指定的照指定的来");
  delete process.env.WIN_REMOTE_PROJECT;
  console.log("✓ win-remote 选对端项目：按目录名认两代、认不出或有歧义就拒绝、指定的优先");
} finally {
  server.close();
}
