import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon" };
const json = (response, value, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

export async function startQuestionCardStage(port = 0) {
  await access(join(dist, "index.html"));
  const at = new Date().toISOString();
  const project = { id: "question-ui", name: "手机答题卡验证", repoPath: dirname(dist), createdAt: at };
  const tasks = ["single", "multi", "team", "team-multi", "settling", "team-running"].map((id) => ({
    id, projectId: project.id, title: `答题验证 ${id}`, body: "只验证归档答题卡，不连接真实服务。",
    mode: id.startsWith("team") ? "team" : "single", status: id === "settling" || id === "team-running" ? "running" : "paused",
    archived: id !== "settling" && id !== "team-running", agentType: "codex", parentId: null, groupId: null,
    executorId: null, model: null, reasoningEffort: null, workflowMode: "free", stage: "none", labels: [],
    dependsOn: [], resumeDependsOn: [], createdAt: at, updatedAt: at, endedAt: null, resumePrompt: null,
    question: "确认归档任务的答复", questionOptions: ["保留问题", "取消归档后答复"],
    questionItems: id.includes("multi") ? [
      { question: "问题是否保留？", options: ["保留第一题", "保留建议答案"] },
      { question: "何时可以答复？", options: ["取回后继续", "保留草稿"] },
    ] : null,
  }));
  const answers = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      const control = /^\/__fixture\/tasks\/([^/]+)$/.exec(path);
      if (control && request.method === "POST") {
        const task = tasks.find((candidate) => candidate.id === control[1]);
        if (!task) return json(response, { error: "not found" }, 404);
        let body = "";
        for await (const chunk of request) body += chunk;
        Object.assign(task, JSON.parse(body));
        return json(response, task);
      }
      if (path === "/api/projects") return json(response, [project]);
      if (path === "/api/tasks") return json(response, tasks);
      if (path === "/api/health") return json(response, { ok: true });
      if (path === "/api/auth/state" || path === "/api/settings") return json(response, {});
      if (path === "/api/skills") return json(response, { skills: [], cliCommands: [] });
      const match = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (match) {
        const task = tasks.find((candidate) => candidate.id === match[1]);
        if (!task) return json(response, { error: "not found" }, 404);
        const action = match[2];
        if (!action) return json(response, task);
        if (action === "archive" || action === "unarchive") {
          task.archived = action === "archive";
          return json(response, { task, cleanup: null });
        }
        if (action === "answer") {
          let body = "";
          for await (const chunk of request) body += chunk;
          answers.push({ taskId: task.id, ...JSON.parse(body) });
          if (task.archived) return json(response, { error: "归档问题不能答复" }, 409);
          return json(response, { answered: true });
        }
        if (action === "review") return json(response, { reviewRequested: false, rounds: [] });
        if (action === "team/cua-status") return json(response, { current: { detected: false, processes: [] }, last: null });
        return json(response, []);
      }
      if (path.startsWith("/api/")) return json(response, []);
      const relative = decodeURIComponent(path.replace(/^\/mobile\/app/, ""));
      if (relative.includes("..")) return json(response, { error: "invalid path" }, 400);
      const asset = join(dist, relative === "/" || !relative ? "index.html" : relative);
      let content;
      let contentType = mime[extname(asset)] ?? "application/octet-stream";
      try { content = await readFile(asset); }
      catch { content = await readFile(join(dist, "index.html")); contentType = "text/html"; }
      response.writeHead(200, { "content-type": contentType });
      response.end(content);
    } catch (error) { json(response, { error: String(error) }, 500); }
  });
  await new Promise((fulfill, reject) => server.once("error", reject).listen(port, "127.0.0.1", fulfill));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, tasks, answers,
    close: () => new Promise((fulfill, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : fulfill());
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = await startQuestionCardStage(Number(process.env.PORT ?? 0));
  console.log(`手机答题卡隔离验证：${stage.origin}/mobile/app/task/single`);
}
