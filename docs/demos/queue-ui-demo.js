// 组内排队 · 交互原型(模拟数据,不连后端)。演示三个表面:
// ① 右侧检查器「队列」区块的「排在某任务之后…」入口 —— 存量任务入队(不占会话区)
// ② 新建任务的「接在某任务后再跑」选项 —— 建完入队不起跑,分组随目标任务
// ③ 列表行队列徽标 + 队列抽屉 —— 拖拽重排/移出,复刻现有 QueueDrawer 语义
// 左侧边栏保持平铺干净:不加组标题行,分组只在检查器属性行与候选浮层里出现。
// 推进规则照抄服务端 advanceQueue:同队至多一个在跑,前驱终态(done/failed/canceled)透明跳过。

const GROUPS = { g1: "发布 0.9", g2: "日常" };
const STATUS_LABEL = {
  running: "运行中", queued: "排队中", backlog: "待办", paused: "已暂停",
  done: "已完成", failed: "失败", canceled: "已取消",
};
const TERMINAL = new Set(["done", "failed", "canceled"]);

function initialState() {
  return {
    tasks: [
      { id: "t1", title: "跑通端到端回归测试", group: "g1", status: "running", body: "在 CI 上完整跑一遍 e2e 套件,失败用例逐个排查到绿。" },
      { id: "t2", title: "更新发布说明", group: "g1", status: "backlog", body: "整理本迭代的改动清单,写进 CHANGELOG 与发布公告草稿。" },
      { id: "t3", title: "构建产物并打 tag", group: "g1", status: "backlog", body: "跑 release 构建,核对产物清单后打 v0.9 tag。" },
      { id: "t4", title: "同步文档站", group: "g1", status: "backlog", body: "把新功能文档同步到文档站并检查死链。" },
      { id: "t5", title: "清理 CI 缓存", group: "g1", status: "done", body: "清掉过期的依赖缓存,给 release 构建腾空间。" },
      { id: "t6", title: "整理 issue 标签", group: "g2", status: "backlog", body: "把新进 issue 按模块打标签,关闭重复项。" },
    ],
    queues: { q1: ["t1", "t2"] },
    selectedId: "t1",
    nextId: 7,
  };
}
let S = initialState();

const $ = (sel) => document.querySelector(sel);
const byId = (id) => S.tasks.find((t) => t.id === id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function qOf(taskId) {
  for (const [qid, arr] of Object.entries(S.queues)) {
    const pos = arr.indexOf(taskId);
    if (pos >= 0) return { qid, arr, pos };
  }
  return null;
}
// 服务端 advanceQueue 的镜像:跳过终态,第一个非终态若还没跑就拉起;已在跑则不动。
function advanceQueue(qid) {
  for (const id of S.queues[qid] ?? []) {
    const t = byId(id);
    if (!t || TERMINAL.has(t.status)) continue;
    if (t.status === "running" || t.status === "queued") return null;
    t.status = "running";
    return t;
  }
  return null;
}
// 「接在 target 之后」落库:target 有队列就紧随其后插入,没有就建一条 [target, subject]。
function placeAfter(subjectId, targetId) {
  const tq = qOf(targetId);
  let qid;
  if (tq) { tq.arr.splice(tq.pos + 1, 0, subjectId); qid = tq.qid; }
  else { qid = `q${S.nextId++}`; S.queues[qid] = [targetId, subjectId]; }
  const started = advanceQueue(qid);
  return { qid, started };
}

// ── 候选列表(① 与 ② 共用)──────────────────────────
// subject.kind: "task"(存量任务,分组固定) / "composer"(新任务,分组随目标)。
// 按用户拍板:全部列出不过滤,不合法的置灰并说明原因。
function candidatesFor(subject) {
  const list = [];
  const ordered = [...S.tasks].sort((a, b) =>
    (a.group === subject.group ? 0 : 1) - (b.group === subject.group ? 0 : 1));
  for (const t of ordered) {
    if (t.id === subject.selfId) continue;
    const inQueue = qOf(t.id);
    let reason = null;
    if (subject.kind === "task" && t.group !== subject.group) {
      reason = `在组「${GROUPS[t.group]}」· 跨组不能同队`;
    } else if (!inQueue && TERMINAL.has(t.status)) {
      reason = "已结束 · 排在它后面等于立刻开始";
    }
    const sub = inQueue
      ? `队列第 ${inQueue.pos + 1} 位 · 共 ${inQueue.arr.length} 个`
      : STATUS_LABEL[t.status];
    const note = subject.kind === "composer" && t.group !== subject.group && !reason
      ? ` · 选它则新任务归入组「${GROUPS[t.group]}」` : "";
    list.push({ t, reason, sub: sub + note });
  }
  return list;
}

// ── 浮层基础设施:toast / 确认框 / 候选浮层 ─────────
let toastTimer = null;
function toast(msg, action) {
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = action.label;
    btn.onclick = () => { el.hidden = true; action.fn(); };
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function showConfirm({ title, message, confirmLabel, onConfirm }) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.style.zIndex = "98";
  const box = document.createElement("div");
  box.className = "confirm";
  box.innerHTML = `<h3>${esc(title)}</h3><p>${esc(message)}</p>
    <div class="confirm-actions"><button type="button" class="ghost-btn" data-x>取消</button>
    <button type="button" class="danger" data-ok>${esc(confirmLabel)}</button></div>`;
  const close = () => { scrim.remove(); box.remove(); };
  scrim.onclick = close;
  box.querySelector("[data-x]").onclick = close;
  box.querySelector("[data-ok]").onclick = () => { close(); onConfirm(); };
  $("#layer").append(scrim, box);
}

let pickerEl = null;
function closePicker() {
  pickerEl?.remove();
  pickerEl = null;
  document.removeEventListener("mousedown", onPickerOutside, true);
}
function onPickerOutside(e) { if (pickerEl && !pickerEl.contains(e.target)) closePicker(); }
function openPicker(anchor, subject, onPick) {
  closePicker();
  const el = document.createElement("div");
  el.className = "picker";
  el.style.position = "fixed";
  el.innerHTML = `<div class="picker-head"><b>排在哪个任务之后?</b>
    <p>同一分组才能同队;不可选项已置灰并说明原因。</p></div>`;
  let lastGroup = null;
  for (const { t, reason, sub } of candidatesFor(subject)) {
    if (t.group !== lastGroup) {
      lastGroup = t.group;
      const gh = document.createElement("div");
      gh.className = "picker-group";
      gh.textContent = `组「${GROUPS[t.group]}」`;
      el.appendChild(gh);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item";
    btn.disabled = !!reason;
    btn.innerHTML = `<span class="dot ${t.status}"></span>
      <span class="p-main"><b>${esc(t.title)}</b><small>${esc(sub)}</small></span>
      ${reason ? `<span class="p-reason">${esc(reason)}</span>` : ""}`;
    if (!reason) btn.onclick = () => { closePicker(); onPick(t); };
    el.appendChild(btn);
  }
  $("#layer").appendChild(el);
  const r = anchor.getBoundingClientRect();
  const h = Math.min(el.offsetHeight, 420);
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 392))}px`;
  el.style.top = `${r.bottom + h + 12 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  pickerEl = el;
  document.addEventListener("mousedown", onPickerOutside, true);
}

// ── ③ 队列抽屉(复刻 QueueDrawer:拖拽重排/移出)────
let drawer = { qid: null, els: null, dragIndex: null };
function closeDrawer() { drawer.els?.forEach((e) => e.remove()); drawer = { qid: null, els: null, dragIndex: null }; }
function openDrawer(qid) {
  closeDrawer();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.onclick = closeDrawer;
  const aside = document.createElement("aside");
  aside.className = "queue-drawer";
  drawer = { qid, els: [scrim, aside], dragIndex: null };
  $("#layer").append(scrim, aside);
  renderDrawer();
}
function renderDrawer() {
  const { qid } = drawer;
  const arr = S.queues[qid];
  if (!arr) return closeDrawer();
  const aside = drawer.els[1];
  aside.innerHTML = `<header><div style="display:flex;align-items:baseline;gap:8px">
      <span>队列</span><b>${arr.length} 个任务</b></div>
      <button type="button" aria-label="关闭队列"><svg class="ic"><use href="#i-close"/></svg></button></header>
    <p class="queue-hint">拖拽可调整顺序;运行中和排队中的任务不可移动或移出。</p>
    <div class="queue-list"></div>
    <footer>摘出后任务本身保留,只是不再由这条队列自动调度。</footer>`;
  aside.querySelector("header button").onclick = closeDrawer;
  const listEl = aside.querySelector(".queue-list");
  arr.forEach((id, index) => {
    const t = byId(id);
    const locked = t.status === "running" || t.status === "queued";
    const row = document.createElement("div");
    row.className = `queue-row${id === S.selectedId ? " is-current" : ""}`;
    row.draggable = !locked;
    row.innerHTML = `<svg class="ic"><use href="#i-${locked ? "lock" : "drag"}"/></svg>
      <span class="q-pos">${index + 1}</span>
      <span class="q-main"><b>${esc(t.title)}</b><small>${STATUS_LABEL[t.status]}</small></span>
      ${locked ? "" : `<button type="button" class="q-remove" aria-label="移出队列"><svg class="ic"><use href="#i-close"/></svg></button>`}`;
    row.ondragstart = (e) => {
      if (locked) return e.preventDefault();
      drawer.dragIndex = index;
      e.dataTransfer.effectAllowed = "move";
    };
    row.ondragover = (e) => {
      if (drawer.dragIndex === null) return;
      e.preventDefault();
      listEl.querySelectorAll(".queue-row").forEach((r, i) => r.classList.toggle("is-over", i === index));
    };
    row.ondragend = () => { drawer.dragIndex = null; renderDrawer(); };
    row.ondrop = (e) => { e.preventDefault(); dropInQueue(index); };
    const rm = row.querySelector(".q-remove");
    if (rm) rm.onclick = () => showConfirm({
      title: "从队列移除",
      message: `确定把「${t.title}」移出队列?任务本身不会删除。`,
      confirmLabel: "移出队列",
      onConfirm: () => {
        S.queues[qid] = S.queues[qid].filter((x) => x !== id);
        if (S.queues[qid].length === 0) delete S.queues[qid];
        else advanceQueue(qid);
        renderAll(); renderDrawer();
        toast(`已把「${t.title}」移出队列`);
      },
    });
    listEl.appendChild(row);
  });
}
function dropInQueue(index) {
  const from = drawer.dragIndex;
  drawer.dragIndex = null;
  const arr = S.queues[drawer.qid];
  if (from === null || from === index || !arr) return renderDrawer();
  const next = [...arr];
  next.splice(index, 0, next.splice(from, 1)[0]);
  // 镜像服务端约束:running/queued 成员的位置不能被挪动
  const moved = arr.some((id, i) => {
    const t = byId(id);
    return (t.status === "running" || t.status === "queued") && next.indexOf(id) !== i;
  });
  if (moved) { toast("运行中/排队中的任务位置不能变,已还原"); return renderDrawer(); }
  S.queues[drawer.qid] = next;
  advanceQueue(drawer.qid);
  renderAll(); renderDrawer();
}

// ── 左侧列表:平铺,不加组标题行,行尾徽标 ───────────
function renderList() {
  const root = $("#task-list");
  root.innerHTML = "";
  for (const t of S.tasks) {
    const q = qOf(t.id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `task-row${t.id === S.selectedId ? " is-selected" : ""}`;
    row.innerHTML = `<span class="dot ${t.status}"></span><span class="t-title">${esc(t.title)}</span>
      ${q ? `<span class="queue-badge" role="button" aria-label="查看队列"><svg class="ic ic-inline"><use href="#i-list"/></svg>${q.pos + 1}/${q.arr.length}</span>` : ""}
      ${t.status !== "backlog" ? `<span class="t-status">${STATUS_LABEL[t.status]}</span>` : ""}`;
    row.onclick = () => { S.selectedId = t.id; renderAll(); };
    const badge = row.querySelector(".queue-badge");
    if (badge) badge.onclick = (e) => { e.stopPropagation(); openDrawer(q.qid); };
    root.appendChild(row);
  }
}

// ── 中间会话区:排队 UI 不进这里 ────────────────────
function renderConvo() {
  const t = byId(S.selectedId);
  const root = $("#convo");
  if (!t) { root.innerHTML = ""; return; }
  const agentMsg = {
    running: "收到,正在执行中…(模拟会话,这一栏只放对话,排队设置都在右侧检查器里)",
    backlog: "任务还没开始。排队信息看右侧检查器的「队列」一节。",
    paused: "已暂停,等待续跑指令。",
    done: "已完成。产出和验证结论会出现在这里。",
    failed: "执行失败,错误详情会出现在这里。",
    queued: "已被队列拉起,马上开始。",
    canceled: "任务已取消。",
  }[t.status];
  root.innerHTML = `<div class="convo-head"><h1>${esc(t.title)}</h1>
      <span class="chip ${t.status}">${STATUS_LABEL[t.status]}</span></div>
    <div class="convo-body">
      <div class="msg user"><small>用户</small>${esc(t.body)}</div>
      <div class="msg agent"><small>agent</small>${esc(agentMsg)}</div>
    </div>
    <div class="convo-reply">回复这个任务…(演示占位)</div>`;
}

// ── ① 右侧检查器:队列区块(紧凑,照抄真实样式)─────
function renderInspector() {
  const t = byId(S.selectedId);
  const root = $("#inspector");
  if (!t) { root.innerHTML = ""; return; }
  const q = qOf(t.id);
  const next = q ? q.arr.slice(q.pos + 1).map(byId).find((x) => !TERMINAL.has(x.status)) : null;
  let queueHtml;
  if (q) {
    queueHtml = `<div class="insp-row"><span>所在位置</span><div>第 ${q.pos + 1} / ${q.arr.length} 位</div></div>
      <div class="insp-row"><span>下一个</span><div>${next ? esc(next.title) : "队尾"}</div></div>
      <button type="button" class="insp-action" data-open-queue>
        <span><svg class="ic ic-sm"><use href="#i-list"/></svg>查看队列 · ${q.arr.length} 个任务</span>
        <svg class="ic ic-sm"><use href="#i-caret"/></svg></button>`;
  } else if (TERMINAL.has(t.status)) {
    queueHtml = `<p class="insp-note">任务已结束,不再参与排队。</p>`;
  } else {
    queueHtml = `<button type="button" class="insp-action" data-place-after>
        <span><svg class="ic ic-sm"><use href="#i-after"/></svg>排在某任务之后…</span>
        <svg class="ic ic-sm"><use href="#i-caret"/></svg></button>
      <p class="insp-note">独立任务,不在任何队列中。选一个同组任务,等它跑完这个再自动开始。</p>`;
  }
  root.innerHTML = `<section><h2>属性</h2>
      <div class="insp-row"><span>状态</span><div>${STATUS_LABEL[t.status]}</div></div>
      <div class="insp-row"><span>分组</span><div>${GROUPS[t.group]}</div></div>
      <div class="insp-row"><span>执行器</span><div>claude · 跟随默认</div></div></section>
    <section><h2>队列</h2>${queueHtml}</section>
    ${t.status === "running" ? `<section><h2>演示</h2>
      <button type="button" class="insp-action" data-sim>
        <span><svg class="ic ic-sm"><use href="#i-check"/></svg>模拟:让这个任务完成</span></button>
      <p class="insp-note">仅演示用,看队列自动推进(前驱完成→下一个开跑)。</p></section>` : ""}`;
  root.querySelector("[data-open-queue]")?.addEventListener("click", () => openDrawer(q.qid));
  root.querySelector("[data-place-after]")?.addEventListener("click", (e) => {
    openPicker(e.currentTarget, { kind: "task", group: t.group, selfId: t.id }, (target) => {
      const { qid, started } = placeAfter(t.id, target.id);
      const pos = S.queues[qid].indexOf(t.id) + 1;
      renderAll();
      toast(
        started?.id === t.id
          ? `「${target.title}」已结束,「${t.title}」立刻开始运行`
          : `已排在「${target.title}」之后 · 队列第 ${pos} 位`,
        { label: "查看队列", fn: () => openDrawer(qid) },
      );
    });
  });
  root.querySelector("[data-sim]")?.addEventListener("click", () => {
    t.status = "done";
    const tq = qOf(t.id);
    const started = tq ? advanceQueue(tq.qid) : null;
    renderAll();
    toast(`「${t.title}」已完成${started ? `,队列推进:「${started.title}」开始运行` : ""}`);
  });
}

// ── ② 新建任务面板 ───────────────────────────────
let composer = null; // { els, afterId }
function closeComposer() { composer?.els.forEach((e) => e.remove()); composer = null; }
function openComposer() {
  closeComposer();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.onclick = closeComposer;
  const panel = document.createElement("div");
  panel.className = "composer";
  panel.innerHTML = `<header><b>新建任务</b><span class="chip">组内排队演示</span>
      <button type="button" aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button></header>
    <div class="composer-body">
      <label>标题<input type="text" placeholder="例:发布后冒烟检查" data-title /></label>
      <label>说明<textarea placeholder="交给 agent 执行的目标…" data-body></textarea></label>
      <label>分组<select data-group>${Object.entries(GROUPS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      <div class="after-field"><span>排队(可选)</span>
        <button type="button" class="after-trigger" data-after>
          <span class="placeholder">接在某任务后再跑…</span>
          <svg class="ic"><use href="#i-caret"/></svg></button>
        <p class="after-hint" data-hint hidden></p></div>
    </div>
    <footer><span class="note" data-note>建完立即开始运行(模拟)</span>
      <button type="button" class="ghost-btn" data-cancel>取消</button>
      <button type="button" class="primary-btn" data-submit><svg class="ic"><use href="#i-play"/></svg><span>创建并运行</span></button></footer>`;
  composer = { els: [scrim, panel], afterId: null };
  $("#layer").append(scrim, panel);

  const groupSel = panel.querySelector("[data-group]");
  const trigger = panel.querySelector("[data-after]");
  const hint = panel.querySelector("[data-hint]");
  const note = panel.querySelector("[data-note]");
  const submit = panel.querySelector("[data-submit]");
  const syncAfterUi = () => {
    const target = composer.afterId ? byId(composer.afterId) : null;
    trigger.innerHTML = target
      ? `<span>接在「${esc(target.title)}」之后</span>
         <span class="a-clear" role="button" aria-label="清除排队选择"><svg class="ic"><use href="#i-close"/></svg></span>`
      : `<span class="placeholder">接在某任务后再跑…</span><svg class="ic"><use href="#i-caret"/></svg>`;
    hint.hidden = !target;
    if (target) hint.textContent = `将归入组「${GROUPS[target.group]}」· 建完入队不起跑,轮到它时自动开始`;
    note.textContent = target ? "建完入队,不立即起跑" : "建完立即开始运行(模拟)";
    submit.querySelector("span").textContent = target ? "创建并排队" : "创建并运行";
    trigger.querySelector(".a-clear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      composer.afterId = null;
      syncAfterUi();
    });
  };
  panel.querySelector("header button").onclick = closeComposer;
  panel.querySelector("[data-cancel]").onclick = closeComposer;
  trigger.onclick = () => openPicker(trigger, { kind: "composer", group: groupSel.value, selfId: null }, (target) => {
    composer.afterId = target.id;
    groupSel.value = target.group; // 分组随目标任务(后端要求同组)
    syncAfterUi();
  });
  groupSel.onchange = () => {
    const target = composer.afterId ? byId(composer.afterId) : null;
    if (target && target.group !== groupSel.value) {
      composer.afterId = null;
      syncAfterUi();
      toast("改了分组,已清除排队选择(跨组不能同队)");
    }
  };
  submit.onclick = () => {
    const title = panel.querySelector("[data-title]").value.trim() || "未命名任务";
    const body = panel.querySelector("[data-body]").value.trim() || "(演示任务,没有正文)";
    const t = { id: `t${S.nextId++}`, title, group: groupSel.value, status: "backlog", body };
    S.tasks.push(t);
    const afterId = composer.afterId;
    closeComposer();
    if (afterId) {
      const target = byId(afterId);
      const { qid, started } = placeAfter(t.id, afterId);
      S.selectedId = t.id;
      renderAll();
      toast(
        started?.id === t.id
          ? `已创建;「${target.title}」已结束,新任务立刻开始运行`
          : `已创建并排在「${target.title}」之后,轮到它时自动开始`,
        { label: "查看队列", fn: () => openDrawer(qid) },
      );
    } else {
      t.status = "running";
      S.selectedId = t.id;
      renderAll();
      toast(`「${title}」已创建并开始运行(模拟)`);
    }
  };
  panel.querySelector("[data-title]").focus();
}

// ── 全局 ─────────────────────────────────────────
function renderAll() { renderList(); renderConvo(); renderInspector(); }
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (pickerEl) return closePicker();
  if (composer) return closeComposer();
  closeDrawer();
});
$("#open-composer").onclick = openComposer;
$("#reset").onclick = () => {
  S = initialState();
  closePicker(); closeComposer(); closeDrawer();
  renderAll();
  toast("演示数据已重置");
};
renderAll();
