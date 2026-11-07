// ⌘K 搜索面板的交互回归夹具（断言在 test-palette-search.mjs）。
//
// 三件事在这里被钉住：键盘移动时选中行要留在视线内、鼠标划过不改选中（单击选中、
// 双击才打开）、排序档切换后请求真的换了档。
//
// 搜索走 `/api/search/stream`（NDJSON 流），这里照做一份：命中的顺序由 `sort` 决定 ——
// 服务端定扫描顺序，前端拿同一份 compareSearchHits 插队。夹具按档位吐好，于是断言也
// 顺带验了前端没有自己另排一遍。
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProjectView, SearchHit, TaskListItem } from "@ash/shared";
// global.css 必须排在组件之前 —— `main.tsx` 就是这个顺序。
import "../../src/styles/global.css";
import "../../src/styles/overlays.css";
import { CommandPalette } from "../../src/overlays/CommandPalette.tsx";

const iso = (minute: number) => new Date(Date.parse("2026-08-01T00:00:00.000Z") + minute * 60_000).toISOString();

const project = {
  id: "p1",
  name: "harness",
  repoPath: "/srv/harness/hit-00",
  createdAt: iso(0),
  health: { exists: true, isRepo: true },
  myRole: "admin",
} as unknown as ProjectView;

// 30 条命中，足够把结果列撑出滚动条。前 20 条是标题档、后 10 条是会话档且**更新更近** ——
// 于是两个排序档的第一条不一样，界面上一眼能验出来换档生效了。
const taskHits: SearchHit[] = Array.from({ length: 30 }, (_, index) => ({
  kind: "task",
  id: `hit-${String(index).padStart(2, "0")}`,
  title: `链接命中 ${index}`,
  status: "done",
  projectId: "p1",
  projectName: "harness",
  archived: false,
  field: index < 20 ? "title" : "conversation",
  snippet: index < 20 ? "" : `会话里的链接 ${index}`,
  preview: `第 ${index} 条的正文`,
  createdAt: iso(index),
  updatedAt: iso(index < 20 ? index : index + 100),
}));

// 全场最新的一条是随手记：相关度档把它压在所有任务之后，最近更新档它该排第一。
const noteHit: SearchHit = {
  kind: "note",
  id: "note-01",
  title: "随手记里的链接",
  projectId: "p1",
  projectName: "harness",
  field: "body",
  snippet: "随手记里的链接",
  preview: "随手记正文",
  createdAt: iso(500),
  updatedAt: iso(500),
  taskCount: 0,
};

const hits = [...taskHits, noteHit];

const byRelevance = [...hits];
const byRecent = [...hits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// 双击打开时面板要能从任务列表里找到这一条（找不到才会去打 `/tasks/:id`）。
const tasks = taskHits.map((hit) => ({
  id: hit.id,
  title: hit.title,
  projectId: hit.projectId,
  status: "done",
  mode: "single",
  archived: false,
  parentId: null,
  groupId: null,
  queueId: null,
  question: null,
  labels: [],
  createdAt: hit.createdAt,
  updatedAt: hit.updatedAt,
})) as unknown as TaskListItem[];

// 每次搜索请求都记一笔，测试据此断言 sort 参数确实跟着开关走。
const requested: string[] = [];
(window as unknown as { __searchRequests: string[] }).__searchRequests = requested;
const controls = window as unknown as {
  __releaseOldSearch?: () => void;
  __appendSearch?: () => void;
  __failSearch?: boolean;
  __releaseCommandSearch?: () => void;
};
const deepHit: SearchHit = {
  ...taskHits[0]!, title: "很长的历史任务：检索范围与上下文展示的完整排查记录，命中位置在正文深处",
  field: "body", snippet: "…正文第八千字附近的深处标记，不能只看开头…",
  preview: "无关开头".repeat(500),
  excerpts: ["…正文第八千字附近的深处标记，包含真正需要查看的处理方案…", "…另一个很远的命中片段，解释为什么需要保留完整上下文…"],
};
const responseOf = (rows: SearchHit[]) => new Response(`${rows.map((hit) => JSON.stringify(hit)).join("\n")}\n`, {
  status: 200, headers: { "content-type": "application/x-ndjson" },
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, location.origin);
  if (url.pathname === "/api/search/stream") {
    const sort = url.searchParams.get("sort") ?? "relevance";
    requested.push(sort);
    const query = url.searchParams.get("q");
    if (query === "新建任务" || query === "harness") return new Promise<Response>((resolve) => {
      controls.__releaseCommandSearch = () => resolve(responseOf(hits));
    });
    if (query === "hit-00") return responseOf([{ ...taskHits[0]!, field: "id" }, taskHits[1]!]);
    if (query === "深处" || query === "图" || query === "任务") return responseOf([deepHit]);
    if (query === "故障") return controls.__failSearch === false ? responseOf([deepHit]) : new Response("unavailable", { status: 503 });
    if (query === "半截") return new Response(`${JSON.stringify(deepHit)}\n{broken`, { status: 200 });
    if (query === "旧查询") return new Promise<Response>((resolve) => {
      controls.__releaseOldSearch = () => resolve(responseOf([{ ...deepHit, title: "不该出现的旧结果" }]));
    });
    if (query === "流式") {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(taskHits[0])}\n${JSON.stringify(taskHits[1])}\n${JSON.stringify(taskHits[0])}\n`));
          controls.__appendSearch = () => {
            controller.enqueue(encoder.encode(`${JSON.stringify({ ...taskHits[2], updatedAt: iso(1000) })}\n`));
            controller.close();
          };
        },
      }), { status: 200 });
    }
    const rows = sort === "recent" ? byRecent : byRelevance;
    return new Response(`${rows.map((hit) => JSON.stringify(hit)).join("\n")}\n`, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
  }
  return realFetch(input as never, init);
};

function Fixture() {
  // 打开过哪些任务：单击只该选中，双击才该走到这里。
  const [opened, setOpened] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  return (
    <>
      <div id="opened" data-opened={opened.join(",")} />
      <div id="actions" data-actions={actions.join(",")} />
      <CommandPalette
        open
        projects={[project]}
        currentProject={project}
        tasks={tasks}
        selectedTask={null}
        groups={[]}
        onClose={() => {}}
        onProject={(id) => setActions((all) => [...all, `project:${id}`])}
        onTaskMode={() => {}}
        onTask={(task) => setOpened((all) => [...all, task.id])}
        onTaskUpdated={() => {}}
        onNote={() => {}}
        onComposer={(mode) => setActions((all) => [...all, `new:${mode}`])}
        onNewGroup={() => {}}
        onNewProject={() => {}}
        onDeleteTask={() => {}}
        onSettings={() => {}}
        notify={() => {}}
      />
    </>
  );
}

// 排序档是记在 localStorage 里的；夹具每次都从「相关度」开始，免得上一轮跑剩的档位
// 让断言随机漂。
window.localStorage.removeItem("ash:palette:sort");
createRoot(document.getElementById("root")!).render(<Fixture />);
