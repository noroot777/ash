/* Inspector 删除文件 / 文件夹 —— 交互原型逻辑。
   纯前端假数据：树、中间视图、确认框、toast 都是本地状态，不连后端。 */

// ── 假数据 ────────────────────────────────────────────────
const dir = (name, props, children = []) => ({ kind: "dir", name, children, ...props });
const file = (name, size, props = {}) => ({ kind: "file", name, size, ...props });

const ROOT = [
  dir("server", { git: "modified" }, [
    dir("src", { git: "modified" }, [
      file("file-routes.ts", 4310, { git: "modified" }),
      file("file-browser.ts", 12480),
      file("scm-routes.ts", 16720),
    ]),
  ]),
  dir("web", { git: "modified" }, [
    dir("src", { git: "modified" }, [
      dir("files", { git: "modified" }, [
        file("FileTreeInspector.tsx", 8354, { git: "modified" }),
        file("FileViewer.tsx", 5970, { git: "modified" }),
        file("OpenWithMenu.tsx", 4980),
        file("useFileView.ts", 3538),
        file("fileModel.ts", 5607),
      ]),
    ]),
  ]),
  dir("docs", { git: "untracked" }, [
    dir("demos", { git: "untracked" }, [
      file("inspector-file-delete.html", 6120, { git: "untracked" }),
      file("inspector-file-delete.css", 11240, { git: "untracked" }),
      file("inspector-file-delete.js", 13860, { git: "untracked" }),
      file("new-task-studio.html", 9364),
      file("task-marker-flag.html", 17776),
    ]),
    file("incidents.md", 38210, { git: "modified" }),
  ]),
  dir(".tmp-verify", { git: "untracked", stats: { files: 342, dirs: 18, bytes: 47_100_000, dirty: 0, untracked: 342 } }, [
    file("run-2026-09-22.log", 1_240_000, { git: "untracked" }),
    file("screenshot-01.png", 384_000, { git: "untracked" }),
  ]),
  dir("node_modules", { ignored: true, stats: { files: 68_412, dirs: 5_120, bytes: 1_070_000_000, dirty: 0, untracked: 0 } }, []),
  file("README.md", 17494),
  file("package.json", 2192, { git: "modified" }),
  file("notes.txt", 812, { git: "untracked" }),
  file("shared", 0, { symlink: true }),
];

const BADGE = { modified: "M", untracked: "U", added: "A", deleted: "D" };
const GIT_LABEL = { modified: "已修改", untracked: "未跟踪", added: "新增", deleted: "已删除" };

const SNIPPET = `export function FileViewer({ taskId, path, onClose, notify }) {
  const [file, setFile] = useState(null);
  // 摆在中间那一栏而不是另开弹层：看文件时通常要对着 agent 说话，
  // 弹层会把回复框盖住。关掉它就回到会话。
  useEffect(() => {
    api.taskFile(taskId, path).then((result) => setFile(result.file));
  }, [path, taskId]);

  return (
    <div className="file-viewer" aria-label="文件查看">
      …
    </div>
  );
}`;

// ── 状态 ──────────────────────────────────────────────────
const state = {
  expanded: new Set(["web", "web/src", "web/src/files", "docs"]),
  showIgnored: false,
  stage: { kind: "chat" },
  busy: "idle",      // idle | running
  trash: true,       // 这台机器有没有可用的废纸篓
  dialog: null,
  typed: "",
};

const $ = (id) => document.getElementById(id);
const svg = (id, cls = "ico13") => `<svg class="${cls}"><use href="#${id}"/></svg>`;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// 树的路径工具：节点上不存路径，按父级前缀算出来，跟真实实现一致。
function walk(nodes, prefix = "", out = new Map()) {
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    out.set(path, node);
    node._path = path;
    if (node.children) walk(node.children, path, out);
  }
  return out;
}
let INDEX = walk(ROOT);

const nodeAt = (path) => INDEX.get(path) ?? null;

function statsOf(node) {
  if (node.stats) return node.stats;
  const acc = { files: 0, dirs: 0, bytes: 0, dirty: 0, untracked: 0 };
  for (const child of node.children ?? []) {
    if (child.kind === "dir") {
      acc.dirs += 1;
      const inner = statsOf(child);
      acc.files += inner.files; acc.dirs += inner.dirs; acc.bytes += inner.bytes;
      acc.dirty += inner.dirty; acc.untracked += inner.untracked;
    } else {
      acc.files += 1; acc.bytes += child.size ?? 0;
      if (child.git === "modified") acc.dirty += 1;
      if (child.git === "untracked") acc.untracked += 1;
    }
  }
  return acc;
}

// ── 文件树 ────────────────────────────────────────────────
function renderTree() {
  const active = state.stage.kind === "chat" ? null : state.stage.path;
  const lines = [];
  const level = (nodes, prefix, depth) => {
    const visible = state.showIgnored ? nodes : nodes.filter((n) => !n.ignored);
    for (const node of visible) {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      const open = state.expanded.has(path);
      const isDir = node.kind === "dir";
      const label = [node.name, node.git ? GIT_LABEL[node.git] : null].filter(Boolean).join("，");
      lines.push(`
        <div class="row-wrap">
          <button type="button" class="file-tree__row${path === active ? " is-active" : ""}${node.ignored ? " is-ignored" : ""}"
                  data-path="${path}" data-act="${isDir ? "toggle" : "open-file"}"
                  ${node.git ? `data-git-kind="${node.git}"` : ""}
                  ${isDir ? `aria-expanded="${open}"` : ""}
                  aria-label="${label}" style="padding-left:${6 + depth * 12}px">
            <span class="file-tree__caret">${isDir ? svg(open ? "i-caret-down" : "i-caret-right", "ico10") : ""}</span>
            <span class="file-tree__glyph">${svg(isDir ? (open ? "i-folder-open" : "i-folder") : "i-file")}</span>
            <span class="file-tree__name">${node.name}</span>
            ${node.symlink ? '<em class="file-tree__tag">软链</em>' : ""}
            ${node.git ? `<span class="file-tree__badge" aria-hidden="true">${isDir ? "●" : BADGE[node.git]}</span>` : ""}
            ${isDir ? "" : `<small>${fmtSize(node.size ?? 0)}</small>`}
          </button>
          ${isDir ? `<button type="button" class="file-tree__peek" data-path="${path}" data-act="open-folder"
                       aria-label="在中间视图打开 ${node.name} 文件夹">${svg("i-open-with", "ico11")}</button>` : ""}
        </div>`);
      if (isDir && open) {
        if (node.children?.length) level(node.children, path, depth + 1);
        else lines.push(`<p class="file-tree__hint" style="padding-left:${10 + (depth + 1) * 12}px">这一层还没读出来（原型里没展开）</p>`);
      }
    }
  };
  level(ROOT, "", 0);
  $("tree").innerHTML = lines.join("");
}

// ── 中间栏 ────────────────────────────────────────────────
function stageChat() {
  return `
    <div class="chat">
      <div class="chat__turn is-me"><small>我</small><p>把 inspector 里的文件删除做出来，文件夹也要能删。</p></div>
      <div class="chat__turn"><small>claude · 刚刚</small><p>点右边文件树里的文件，中间会摊开它；文件夹用行尾那颗按钮打开详情。删除按钮在中间视图的顶栏里。</p></div>
      <p class="chat__hint">← 中间栏默认是会话；摊开文件或文件夹详情会临时占用这块位置，关掉就回来</p>
    </div>`;
}

function viewerBar(node, { subtitle, extra = "" }) {
  const blocked = node.ignored ? "这个路径被 .gitignore 忽略，删除同样生效" : null;
  return `
    <header class="viewer__bar">
      <div class="viewer__title">
        <b>${svg(node.kind === "dir" ? "i-folder-open" : "i-file")}${node.name}</b>
        <small>${subtitle}</small>
      </div>
      ${extra}
      <button type="button" class="viewer__action">${svg("i-reveal")}在文件夹中查看</button>
      <button type="button" class="viewer__action">${svg("i-open-with")}打开方式</button>
      <button type="button" class="viewer__action" aria-label="复制完整路径">${svg("i-copy")}</button>
      <span class="viewer__danger-group">
        <button type="button" class="viewer__action is-danger" data-act="ask-delete" data-path="${node._path}"
                aria-label="删除 ${node._path}"${blocked ? "" : ""}>${svg("i-trash")}删除</button>
        <button type="button" class="viewer__action" aria-label="放大">${svg("i-zoom")}</button>
        <button type="button" class="viewer__action" data-act="close-stage" aria-label="关闭，回到会话">${svg("i-x")}</button>
      </span>
    </header>`;
}

function stageFile(path) {
  const node = nodeAt(path);
  const lines = SNIPPET.split("\n");
  const extra = node.git
    ? `<button type="button" class="viewer__action">${svg("i-diff")}查看改动</button>`
    : "";
  return `
    <div class="viewer" aria-label="文件查看">
      ${viewerBar(node, { subtitle: `${path} · ${fmtSize(node.size ?? 0)}${node.git ? ` · ${GIT_LABEL[node.git]}` : ""}`, extra })}
      <div class="viewer__body">
        <div class="code">
          <div class="code__gutter" aria-hidden="true">${lines.map((_, i) => `<span>${i + 1}</span>`).join("")}</div>
          <pre><code>${lines.join("\n").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</code></pre>
        </div>
      </div>
    </div>`;
}

function stageFolder(path) {
  const node = nodeAt(path);
  const s = statsOf(node);
  const kids = (node.children ?? []).slice(0, 6);
  const rest = Math.max(0, (node.children?.length ?? 0) - kids.length);
  return `
    <div class="viewer" aria-label="文件夹详情">
      ${viewerBar(node, { subtitle: `${path}/ · ${s.files} 个文件 · ${fmtSize(s.bytes)}` })}
      <div class="viewer__body">
        <div class="folder">
          <div class="folder__stats">
            <div class="folder__stat"><b>${s.files.toLocaleString()}</b><span>个文件（含子目录）</span></div>
            <div class="folder__stat"><b>${s.dirs.toLocaleString()}</b><span>个子文件夹</span></div>
            <div class="folder__stat"><b>${fmtSize(s.bytes)}</b><span>合计大小</span></div>
            <div class="folder__stat" data-tone="dirty"><b>${s.dirty}</b><span>个有未提交改动</span></div>
            <div class="folder__stat" data-tone="untracked"><b>${s.untracked.toLocaleString()}</b><span>个未跟踪（git 里没有备份）</span></div>
          </div>
          <section class="folder__section">
            <h3>这一层里有什么<em>${node.children?.length ?? 0} 项${rest ? `，只列前 ${kids.length} 项` : ""}</em></h3>
            <div class="folder__list">
              ${kids.map((child) => `
                <button type="button" class="folder__item" data-act="${child.kind === "dir" ? "open-folder" : "open-file"}" data-path="${child._path}">
                  ${svg(child.kind === "dir" ? "i-folder" : "i-file")}
                  <b>${child.name}</b>
                  ${child.git ? `<i data-git="${child.git}">${GIT_LABEL[child.git]}</i>` : ""}
                  <small>${child.kind === "dir" ? `${statsOf(child).files} 项` : fmtSize(child.size ?? 0)}</small>
                </button>`).join("")}
              ${rest ? `<p class="file-tree__hint" style="padding:8px 12px">…… 还有 ${rest} 项</p>` : ""}
            </div>
          </section>
          <p class="folder__note">${svg("i-warning")}<span>删除这个文件夹＝连同里面 ${s.files.toLocaleString()} 个文件一起删。${s.untracked ? `其中 <b>${s.untracked.toLocaleString()}</b> 个未跟踪，git 里没有任何备份。` : ""}</span></p>
        </div>
      </div>
    </div>`;
}

function renderStage() {
  const view = state.stage;
  $("stage").innerHTML = view.kind === "file" ? stageFile(view.path)
    : view.kind === "folder" ? stageFolder(view.path)
      : stageChat();
}

// ── 确认框 ────────────────────────────────────────────────
function deletePlan(path) {
  const node = nodeAt(path);
  const isDir = node.kind === "dir";
  const s = isDir ? statsOf(node) : null;
  const items = isDir ? s.files + s.dirs : 1;
  // 抄名字的门槛：删文件夹（非空）、或这台机器没有废纸篓 —— 两种都是「点错了就回不来」。
  const needsType = (isDir && items > 0) || !state.trash;
  return { node, isDir, stats: s, items, needsType };
}

function dialogHTML(plan) {
  const { node, isDir, stats, needsType } = plan;
  const where = state.trash
    ? { cls: "is-ok", icon: "i-check", title: "去向：系统废纸篓", body: "在访达里能「放回原处」。ash 不做自己的回收站——系统那个用户本来就会用。" }
    : { cls: "is-warn", icon: "i-warning", title: "这台机器上没有可用的废纸篓", body: "删除会直接落到磁盘上，没有兜底。所以下面要求抄一遍名字。" };

  const noBackup = state.trash ? "删掉之后只剩废纸篓这一份。" : "删掉之后就真没了——git 里没有，废纸篓也没有。";
  const gitFact = node.git === "untracked" || (isDir && stats?.untracked)
    ? {
      cls: "is-danger", icon: "i-warning", title: "有未跟踪内容，git 里没有备份",
      body: isDir
        ? `这个文件夹里有 ${stats.untracked.toLocaleString()} 个未跟踪文件。${noBackup}`
        : `<code>${node._path}</code> 还没进过任何提交。${noBackup}`,
    }
    : { cls: "", icon: "i-scm", title: "被 git 跟踪的部分删掉了也能找回来", body: "删除后它会在「源代码管理」里变成一条 deleted 改动，丢弃那条改动就恢复到上次提交的样子；未提交的那部分只能去废纸篓找。" };

  const busyFact = state.busy === "running"
    ? `<div class="fact is-danger">${svg("i-warning", "ico16")}<div><b>有任务正在这个工作目录里运行</b>
        <p>当前任务 <code>#kiMZNL</code> 在跑，另有 2 个执行者共用这个目录。删掉的可能是它几秒前刚写出来、还没提交的成果。</p></div></div>`
    : "";

  const sample = isDir
    ? `<ul>${(node.children ?? []).slice(0, 4).map((c) => `<li>${c._path}${c.kind === "dir" ? "/" : ""}</li>`).join("")}${(node.children?.length ?? 0) > 4 ? `<li>…… 还有 ${(node.children.length - 4).toLocaleString()} 项</li>` : ""}</ul>`
    : "";

  const title = isDir ? `删除 ${node.name} 文件夹` : `删除 ${node.name}`;
  const message = isDir
    ? `<code>${node._path}/</code> 里有 ${stats.files.toLocaleString()} 个文件、${stats.dirs.toLocaleString()} 个子文件夹，合计 ${fmtSize(stats.bytes)}，会整个${state.trash ? "移到废纸篓" : "从磁盘上删掉"}。`
    : `会把 <code>${node._path}</code>（${fmtSize(node.size ?? 0)}）从任务工作目录里${state.trash ? "移到废纸篓" : "删掉"}。${node.symlink ? "这是一条软链，只删链接本身，不碰它指向的目标。" : ""}`;

  return `
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
      <header class="dialog__head">
        <span>${svg("i-trash", "ico19")}</span>
        <div><small>HIGH IMPACT ACTION</small><h2 id="dlg-title">${title}</h2></div>
        <button type="button" data-act="close-dialog" aria-label="关闭${title}">${svg("i-x", "ico16")}</button>
      </header>
      <p class="dialog__message">${message}</p>
      ${busyFact}
      <div class="fact ${where.cls}">${svg(where.icon, "ico16")}<div><b>${where.title}</b><p>${where.body}</p></div></div>
      <div class="fact ${gitFact.cls}">${svg(gitFact.icon, "ico16")}<div><b>${gitFact.title}</b><p>${gitFact.body}</p>${sample}</div></div>
      ${needsType ? `
        <div class="confirm-type">
          <label for="typed">抄一遍名字确认：输入 <b>${node.name}</b></label>
          <input id="typed" type="text" autocomplete="off" spellcheck="false" placeholder="在这里一个字一个字地敲" value="${state.typed}">
        </div>` : ""}
      <footer class="dialog__foot">
        <button type="button" data-act="close-dialog">取消</button>
        <button type="button" class="is-danger" data-act="confirm-delete"
          ${needsType && state.typed !== node.name ? "disabled" : ""}>
          ${state.busy === "running" ? "仍然删除" : isDir ? "删除整个文件夹" : "删除文件"}
        </button>
      </footer>
    </section>`;
}

function renderDialog() {
  const scrim = $("scrim");
  if (!state.dialog) { scrim.hidden = true; scrim.innerHTML = ""; return; }
  scrim.hidden = false;
  scrim.innerHTML = dialogHTML(deletePlan(state.dialog));
  const input = $("typed");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${svg("i-check")}<span>${text}</span>`;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

// ── 动作 ──────────────────────────────────────────────────
function removePath(path) {
  const cut = (nodes, prefix) => nodes.filter((node) => {
    const full = prefix ? `${prefix}/${node.name}` : node.name;
    if (full === path) return false;
    if (node.children) node.children = cut(node.children, full);
    return true;
  });
  ROOT.splice(0, ROOT.length, ...cut(ROOT, ""));
  INDEX = walk(ROOT);
}

function doDelete(path) {
  const { node, isDir, stats } = deletePlan(path);
  const name = node.name;
  removePath(path);
  // 摊着的那份东西没了就退回会话；父文件夹被删时里面的文件同理。
  const open = state.stage.kind === "chat" ? null : state.stage.path;
  if (open && (open === path || open.startsWith(`${path}/`))) state.stage = { kind: "chat" };
  state.dialog = null;
  state.typed = "";
  renderAll();
  const scope = isDir ? `${name}/（${stats.files.toLocaleString()} 个文件）` : name;
  toast(state.trash ? `已把 ${scope} 移到废纸篓` : `已删除 ${scope}`);
}

function renderAll() { renderTree(); renderStage(); renderDialog(); }

document.addEventListener("click", (event) => {
  const hit = event.target.closest("[data-act], [data-busy], [data-trash], [data-theme]");
  if (!hit) return;

  if (hit.dataset.busy) {
    state.busy = hit.dataset.busy;
    document.querySelectorAll("[data-busy]").forEach((b) => b.setAttribute("aria-pressed", String(b === hit)));
    renderDialog();
    return;
  }
  if (hit.dataset.trash) {
    state.trash = hit.dataset.trash === "on";
    state.typed = "";
    document.querySelectorAll("[data-trash]").forEach((b) => b.setAttribute("aria-pressed", String(b === hit)));
    renderDialog();
    return;
  }
  if (hit.dataset.theme) {
    document.documentElement.dataset.theme = hit.dataset.theme;
    document.querySelectorAll("[data-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b === hit)));
    return;
  }

  const { act, path } = hit.dataset;
  if (act === "toggle") {
    state.expanded.has(path) ? state.expanded.delete(path) : state.expanded.add(path);
    renderTree();
  } else if (act === "open-file") {
    state.stage = { kind: "file", path };
    renderTree(); renderStage();
  } else if (act === "open-folder") {
    state.stage = { kind: "folder", path };
    state.expanded.add(path);
    renderTree(); renderStage();
  } else if (act === "close-stage") {
    state.stage = { kind: "chat" };
    renderTree(); renderStage();
  } else if (act === "ask-delete") {
    state.dialog = path; state.typed = ""; renderDialog();
  } else if (act === "close-dialog") {
    state.dialog = null; state.typed = ""; renderDialog();
  } else if (act === "confirm-delete") {
    doDelete(state.dialog);
  }
});

$("scrim").addEventListener("mousedown", (event) => {
  if (event.target === event.currentTarget) { state.dialog = null; state.typed = ""; renderDialog(); }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "typed") return;
  state.typed = event.target.value;
  const node = nodeAt(state.dialog);
  const confirm = document.querySelector('[data-act="confirm-delete"]');
  if (confirm && node) confirm.disabled = state.typed !== node.name;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.dialog) { state.dialog = null; state.typed = ""; renderDialog(); }
  if (event.key === "Enter" && state.dialog) {
    const confirm = document.querySelector('[data-act="confirm-delete"]');
    if (confirm && !confirm.disabled) { event.preventDefault(); doDelete(state.dialog); }
  }
});

$("toggleIgnored").addEventListener("click", (event) => {
  state.showIgnored = !state.showIgnored;
  event.currentTarget.setAttribute("aria-pressed", String(state.showIgnored));
  renderTree();
});

renderAll();
