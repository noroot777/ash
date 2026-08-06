/* 数据是编的，但字段和词表都照 harness 现有的来：
   status（backlog/queued/running/paused/awaiting_review/done/failed/canceled）
   与 stage（implemented/verifying/verified/verify_failed/awaiting_acceptance/
   merged/accepted）正交。行里现在只剩状态点这一层 —— chip/step 留在数据里，
   是给「要不要把阶段徽标挪回标题左边」那个待定项备用的。
   bucket 只服务于顶上的筛选：todo=要你拍板，run=在跑，wait=排着/暂停，done=收尾。
   shots = 这条需求 / 这条消息带的图（真实场景里就是你贴的草图、它交的验证截图）。 */
const TASKS = [
  {
    sec: "置顶", id: "t1", title: "事项中心：讨论区 @CLI 派生执行任务", dot: "attention",
    chip: "等答复", tone: "amber", step: "团队 · 执行者 2/4 在跑", meta: "调度台 claude · 已跑 1h12m",
    bucket: "todo", time: "12m",
    body: "事项中心是规划层，rail 分「规划 / 执行」。讨论区里 @ 一个 CLI 智能体就派生出执行任务；执行一律走 CLI，直连 API 只用来解析和识别项目。",
    shots: ["我画的 rail 草图"],
    last: { who: "它问你", cls: "ask", text: "派生任务的项目归属：跟随事项所属项目，还是派生时让用户再选一次？我倾向前者，跨项目的事项目前只占约一成。",
      shots: ["两种归属的对照"] },
  },
  {
    sec: "置顶", id: "t2", title: "侧边栏任务列表横向铺开", dot: "active",
    chip: "运行中", tone: "", step: "工作流 2/5 · 干活", meta: "claude · 已跑 6m",
    bucket: "run", time: "1m",
    body: "任务一多，侧边栏挨个点太累。按快捷键让任务列表向右铺满，多出来的位置写当前走到哪一步、原始需求、最后一次追问，看完点一个就收回。先出 HTML demo。",
    shots: ["我随手画的铺开草图"],
    last: { who: "它说", cls: "", text: "已读完 TaskTree.tsx / taskTreeModel.ts / task-tree.css，正在按 docs/ui-demo-* 的惯例画 demo。",
      shots: ["demo 首屏 · 收起态", "demo 首屏 · 铺开态"] },
  },
  {
    sec: "协作任务", id: "t3", title: "辩论：review 改成旁路回合还是保留独立任务", dot: "active",
    chip: "运行中", tone: "", step: "辩论 第 2 轮 / 共 3 轮", meta: "codex × claude",
    bucket: "run", time: "5m",
    body: "现在每次审查都新建一个独立任务，上下文要重建一遍。改成在被审任务身上跑旁路回合是否更省？请两边各给一轮论据再收敛。",
    last: { who: "正方", cls: "", text: "旁路回合省掉一次完整上下文重建，验证结论也直接落在被验任务的 stage 上，不用再回链。" },
  },
  {
    sec: "协作任务", id: "t4", title: "移动端会话页重构", dot: "quiet",
    chip: "待命", tone: "", step: "团队 · 5 个执行者已收工", meta: "调度台 claude",
    bucket: "wait", time: "42m",
    body: "手机上看任务列表和会话都靠定时拉取，下拉刷新即可，不要加 SSE。这一轮先把会话页拆到 700 行以内，顺手把长按选取接上。",
    last: { who: "它说", cls: "", text: "五个执行者都收工了，typecheck 与 build:mobile 均通过。等你安排下一批。" },
  },
  {
    sec: "普通任务", id: "t5", title: "工作流：关口画在验证前面时不许被跳过", dot: "attention",
    chip: "待验收", tone: "amber", step: "工作流 5/5 · 等你点头", meta: "codex@cpa · 已跑 34m",
    bucket: "todo", time: "8m",
    body: "把人工关口画在自动验证前面时，点了验收会把后面那站验证一起跳过。关口只该放行它自己那一站。",
    shots: ["出问题的那条线"],
    last: { who: "它说", cls: "", text: "验证已过：起了 PORT=14317 的一次性实例，点了三条线（关口在前 / 在后 / 两个关口），截图三张。已停掉服务，请验收。",
      shots: ["关口在前 · 只放行自己那站", "关口在后 · 验证照跑", "两个关口 · 各管各"] },
  },
  {
    sec: "普通任务", id: "t6", title: "停止全组后刷新页面仍能看出「我停过」", dot: "active",
    chip: "验证中", tone: "cyan", step: "工作流 4/5 · 自动验证", meta: "codex@cpa · 已跑 18m",
    bucket: "run", time: "刚刚",
    body: "点了停止全组只弹一个 toast，刷新页面后什么都看不出来，用户只能得出「按钮坏了」。判据是刷新后仍能看出停过。",
    last: { who: "它说", cls: "", text: "已起 5174 预览，正在逐个点：停止 → 刷新 → 组头部应保留「已停止 · 3 个任务被中断」。",
      shots: ["刷新后的组头部"] },
  },
  {
    sec: "普通任务", id: "t7", title: "codex 档位超上限要拒绝，不许静默降级", dot: "active",
    chip: "运行中", tone: "", step: "工作流 2/5 · 干活", meta: "claude · 已跑 3m",
    bucket: "run", time: "3m",
    body: "gpt-5.5 最高只到 xhigh，选 max 时现在会被静默改成 xhigh。应该由「思考强度」那颗胶囊出提示，不静默改。",
    last: { who: "它说", cls: "", text: "正在改执行器 profile 的解析：把上限做进类型，让越界在编译期就挂掉。" },
  },
  {
    sec: "普通任务", id: "t8", title: "worktree 里 shared 解析到主仓那份", dot: "quiet",
    chip: "暂停中", tone: "", step: "检查点 · 等 4317 重启", meta: "claude · 已跑 22m",
    bucket: "wait", time: "1h",
    body: "worktree 里没有 node_modules，改了 shared 的类型后 typecheck 和 server 的测试脚本测的都是主仓那份，改动等于没测。",
    last: { who: "它说", cls: "", text: "已补 node_modules/@harness 软链（mobile 用 cp -Rc 克隆）。等你重启 4317 后我接着验证。" },
  },
  {
    sec: "普通任务", id: "t9", title: "随手记转任务保留历史回链", dot: "pending",
    chip: "排队中", tone: "", step: "队列第 2 位 · 前面还有 1 个", meta: "claude",
    bucket: "wait", time: "—",
    body: "随手记按创建时的项目归属，转成任务后要保留回链。创建成功但回链失败时要如实提示，不能因为回链失败就回滚已经建好的任务。",
    last: { who: "", cls: "", text: "" },
  },
  {
    sec: "普通任务", id: "t10", title: "归档任务也进搜索索引", dot: "pending",
    chip: "待排期", tone: "", step: "还没开始", meta: "未指定执行器",
    bucket: "wait", time: "—",
    body: "Cmd+K 搜不到已归档的任务，但归档只是「结束」不是「删除」，翻旧账的时候找不回来。",
    last: { who: "", cls: "", text: "" },
  },
  {
    sec: "普通任务", id: "t11", title: "团队收工判据统一走 isTeamSettled", dot: "error",
    chip: "失败", tone: "red", step: "工作流 2/5 · 干活时挂了", meta: "codex@cpa · 跑了 9m",
    bucket: "todo", time: "26m",
    body: "收工和被停止是两件事，分别决定时间轴收口和「恢复全组」入口。判据只许有一处，全都走 shared 的 isTeamSettled。",
    last: { who: "它说", cls: "", text: "typecheck 失败：shared/team.ts:88 的 isTeamSettled 少了 idle 分支，web-next 里有两处旧判据没换。已停在这里。",
      shots: ["typecheck 报错原文"] },
  },
  {
    sec: "普通任务", id: "t12", title: "Inspector 只读展示 executorRunSummary", dot: "success",
    chip: "验收完成", tone: "green", step: "已合并进 main", meta: "claude · 跑了 41m",
    bucket: "done", time: "2h",
    body: "同一份 model/effort 不许有第二个编辑入口。Inspector 里的执行信息改成只读展示算出来的生效值。",
    last: { who: "你说", cls: "you", text: "可以合并。" },
  },
  {
    sec: "普通任务", id: "t13", title: "pre-commit 棘轮拦住根文件继续变大", dot: "success",
    chip: "已合并", tone: "green", step: "等你验收", meta: "codex@cpa · 跑了 28m",
    bucket: "done", time: "昨天",
    body: "AGENTS.md 只会往一个方向长。加个棘轮式 hook：只拦增长不拦存量，并且每次提交都报出净变化和当前水位。",
    last: { who: "它说", cls: "", text: "已合并到 main。当前水位 5094 / 8192 字节，本次净减少 312 字节。",
      shots: ["pre-commit 的计账输出"] },
  },
  {
    sec: "普通任务", id: "t14", title: "移动端下拉刷新手感调校", dot: "quiet",
    chip: "已取消", tone: "", step: "被你取消", meta: "claude",
    bucket: "done", time: "昨天",
    body: "列表 5s、会话 3s 定时拉，再加下拉刷新。手感对齐原生。",
    last: { who: "你说", cls: "you", text: "先不做这个，优先级往后放。" },
  },
];

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "todo", label: "需要你处理" },
  { key: "run", label: "在跑" },
  { key: "wait", label: "排着 / 暂停" },
  { key: "done", label: "已收尾" },
];

const $ = (id) => document.getElementById(id);
const win = $("win");
const rowsEl = $("rows");
const rulerBox = $("rulerbox");

let spread = false;
let filter = "all";
let selected = "t2";
let closingTimer = null;

/* ── 渲染 ─────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/* demo 不联网，图片是现造的 SVG 假截图：一个假界面 + 底部一条标题带。
   缩略图上只看得出色调，点开放大才读得出标题 —— 跟真截图的手感一致。 */
const TINT = { "": "#5e6ad2", amber: "#b57b00", green: "#168466", red: "#d93d4c", cyan: "#0e9db8" };
function shot(label, tone) {
  const c = TINT[tone] || TINT[""];
  const bar = (n, x, y, w, h, gap, fill, op) => Array.from({ length: n }, (_, i) =>
    `<rect x="${x}" y="${y + i * gap}" width="${w - ((i * 97) % (w / 3))}" height="${h}" rx="${h / 2}" fill="${fill}" opacity="${op}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" font-family="PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif">
<rect width="960" height="600" fill="#eceef2"/>
<rect x="36" y="28" width="888" height="472" rx="14" fill="#fff" stroke="#dfe2e8"/>
<rect x="36" y="28" width="888" height="36" rx="14" fill="#f6f7f9"/>
<circle cx="62" cy="46" r="5" fill="#dfe2e8"/><circle cx="80" cy="46" r="5" fill="#dfe2e8"/><circle cx="98" cy="46" r="5" fill="#dfe2e8"/>
<rect x="52" y="80" width="206" height="404" rx="10" fill="#f6f7f9"/>
<rect x="66" y="120" width="150" height="13" rx="6.5" fill="${c}" opacity=".8"/>
${bar(6, 66, 156, 160, 11, 42, "#dfe2e8", 1)}
<rect x="282" y="80" width="626" height="146" rx="10" fill="${c}" opacity=".08"/>
${bar(4, 304, 106, 560, 11, 30, c, ".32")}
${bar(7, 282, 254, 600, 11, 32, "#e6e8ec", 1)}
<rect x="36" y="516" width="888" height="56" rx="12" fill="${c}"/>
<text x="480" y="553" text-anchor="middle" font-size="30" font-weight="600" fill="#fff">${esc(label)}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* 有图的格子在右端留一个小标记，不然没人知道该往上指 */
function clip(shots) {
  return shots?.length ? `<i class="clip" title="${shots.length} 张图">▣ ${shots.length}</i>` : "";
}

function rowHtml(t) {
  const hidden = filter !== "all" && t.bucket !== filter;
  const last = t.last.text
    ? `<em class="who ${t.last.cls ? `who--${t.last.cls}` : ""}">${esc(t.last.who)}</em><p>${esc(t.last.text)}</p>${clip(t.last.shots)}`
    : `<p style="color:var(--line2)">还没有消息</p>`;
  return `<button class="row${t.bucket === "todo" ? " is-todo" : ""}${t.id === selected ? " is-sel" : ""}${hidden ? " is-hidden" : ""}" data-id="${t.id}">
    <span class="c c-dot"><i class="dot dot--${t.dot}"></i></span>
    <span class="c c-title"><b>${esc(t.title)}</b></span>
    <span class="c c-body x"><p>${esc(t.body)}</p>${clip(t.shots)}</span>
    <span class="c c-last x">${last}</span>
    <span class="c c-time x">${esc(t.time)}</span>
  </button>`;
}

function render() {
  hidePop(); // 行是整片重画的，旧卡片指着的那个格子已经不在了
  const sections = [...new Set(TASKS.map((t) => t.sec))];
  // 没有列名行：它一插进来，下面每一行就得下移 24px，纵向就不是原地不动了。
  rowsEl.innerHTML = sections.map((sec) => {
    const list = TASKS.filter((t) => t.sec === sec);
    const visible = list.some((t) => filter === "all" || t.bucket === filter);
    return `<div class="sec${visible ? "" : " is-empty"}"><span>${sec}</span></div>` + list.map(rowHtml).join("");
  }).join("");

  const shown = TASKS.filter((t) => filter === "all" || t.bucket === filter).length;
  $("footcount").textContent = `${shown} / ${TASKS.length}`;
  renderFilters();
  renderMain();
  drawRuler();
}

function renderFilters() {
  $("filters").innerHTML = FILTERS.map((f) => {
    const n = f.key === "all" ? TASKS.length : TASKS.filter((t) => t.bucket === f.key).length;
    return `<button class="fb${filter === f.key ? " is-on" : ""}${f.key === "todo" ? " is-todo" : ""}" data-f="${f.key}">
      <b>${f.label}</b><span>${n}</span></button>`;
  }).join("");
}

function renderMain() {
  const t = TASKS.find((x) => x.id === selected) || TASKS[0];
  $("mchip").className = `chip${t.tone ? ` chip--${t.tone}` : ""}`;
  $("mchip").textContent = t.chip;
  $("mtitle").textContent = t.title;
  $("mpath").textContent = `harness · ${t.meta}`;
  $("mreply").textContent = `回复 ${t.meta.split(" · ")[0]}…`;
  const bubbles = [`<div class="msg msg--you"><em>你的原始需求</em><p>${esc(t.body)}</p>${thumbs(t.id, "body")}</div>`];
  if (t.last.text) {
    const cls = t.last.cls === "ask" ? " msg--ask" : t.last.cls === "you" ? " msg--you" : "";
    bubbles.push(`<div class="msg${cls}"><em>${esc(t.last.who)} · ${esc(t.time)}</em><p>${esc(t.last.text)}</p>${thumbs(t.id, "last")}</div>`);
  }
  $("mbody").innerHTML = bubbles.join("");
}

/* ── 图片：缩略图 + 点开看大图 ─────────────────────────
   缩略图只带 taskId:kind 这把钥匙，图列表和色调都回 TASKS 里取，
   免得同一份数据在悬浮卡片、详情气泡、大图三处各存一份。 */
function shotsOf(key) {
  const [id, kind] = key.split(":");
  const t = TASKS.find((x) => x.id === id);
  if (!t) return { list: [], tone: "" };
  return { list: (kind === "body" ? t.shots : t.last.shots) || [], tone: t.tone || "" };
}

function thumbs(id, kind) {
  const { list, tone } = shotsOf(`${id}:${kind}`);
  if (!list.length) return "";
  return `<div class="shots">${list.map((s, i) =>
    `<button class="thumb" data-key="${id}:${kind}" data-i="${i}" title="${esc(s)}"><img src="${shot(s, tone)}" alt="${esc(s)}"></button>`,
  ).join("")}</div>`;
}

const lb = $("lb");
let lbList = [], lbTone = "", lbIdx = 0;

function openLb(key, i) {
  const { list, tone } = shotsOf(key);
  if (!list.length) return;
  [lbList, lbTone, lbIdx] = [list, tone, i];
  lb.hidden = false;
  hidePop();
  drawLb();
}

function drawLb() {
  $("lbimg").src = shot(lbList[lbIdx], lbTone);
  $("lbcap").textContent = lbList.length > 1
    ? `${lbList[lbIdx]} · ${lbIdx + 1}/${lbList.length}`
    : lbList[lbIdx];
  $("lbprev").hidden = $("lbnext").hidden = lbList.length < 2;
}

function stepLb(d) {
  if (lbList.length < 2) return;
  lbIdx = (lbIdx + d + lbList.length) % lbList.length;
  drawLb();
}

function closeLb() {
  lb.hidden = true;
  lbList = [];
}

/* ── 铺开 / 收起 ──────────────────────────────────────── */
function setSpread(next) {
  if (next === spread) return;
  hidePop(); // 宽度一动，卡片就跟它指的那个格子脱节了
  spread = next;
  if (spread) {
    clearTimeout(closingTimer);
    win.classList.remove("is-closing");
    // 先把行钉在最终宽度上，再变宽 —— 右边几列因此不会随宽度回流，看着像拉窗帘。
    // 最终可用宽度 = 窗口内宽 － 侧边栏右侧留的 8 － 侧边栏两侧内边距（两态相同）。
    const pad = parseFloat(getComputedStyle($("side")).paddingLeft) * 2;
    win.style.setProperty("--spread-w", `${win.clientWidth - 8 - pad}px`);
    render();
    // 强制把新的宽列模板同步落地,过渡才有起点。不用 rAF:帧被饿住时(后台标签页、
    // 掉帧)回调会迟到,轻则按了没反应,重则中途收起后它又把 is-spread 加回去。
    void win.offsetWidth;
    win.classList.add("is-spread");
  } else {
    // 收起时保留宽列模板直到宽度动画走完，避免内容先一步消失、留下一片空白。
    win.classList.add("is-closing");
    win.classList.remove("is-spread");
    closingTimer = setTimeout(() => {
      win.classList.remove("is-closing");
      render();
    }, 340);
  }
}

function visibleIds() {
  return TASKS.filter((t) => filter === "all" || t.bucket === filter).map((t) => t.id);
}

function move(step) {
  const ids = visibleIds();
  if (!ids.length) return;
  const i = ids.indexOf(selected);
  selected = ids[Math.min(Math.max((i < 0 ? 0 : i) + step, 0), ids.length - 1)];
  render();
  rowsEl.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
}

/* ── 标尺 ─────────────────────────────────────────────
   照当前每一行的上边缘钉一排红线。切换铺开 / 收起时不重画（setSpread 里
   加 is-spread 之前就已经量完了），所以行只要上下漂一个像素，肉眼立刻看得见。 */
function drawRuler() {
  const on = $("ruler").checked;
  rulerBox.hidden = !on;
  if (!on) { rulerBox.innerHTML = ""; return; }
  const base = win.getBoundingClientRect().top;
  const box = $("tree").getBoundingClientRect();
  rulerBox.innerHTML = [...rowsEl.querySelectorAll(".row:not(.is-hidden)")]
    .map((r) => r.getBoundingClientRect().top)
    .filter((top) => top >= box.top - 0.5 && top <= box.bottom)
    .map((top) => `<i style="top:${Math.round(top - base)}px"></i>`)
    .join("");
}

/* ── 悬浮看全文 ───────────────────────────────────────
   铺开后这两列还是截断的（34px 一行装不下几十个字），所以指上去 160ms 弹全文。
   卡片跟格子之间留了 8px 空隙，指针要横穿这段空白才够得着图 —— 所以移出格子后
   不立刻关，给 140ms 宽限；进了卡片就一直开着，不然图点不到。 */
const pop = $("pop");
const POP_DELAY = 160, POP_GRACE = 140;
let popTimer = null, popHideTimer = null, popCell = null;

function popHtml(t, kind) {
  const isBody = kind === "body";
  const head = isBody
    ? `<b>原始需求</b><span>${esc(t.title)}</span>`
    : `<b>最后一条消息</b><span>${esc(t.last.who || "还没有消息")} · ${esc(t.time)}</span>`;
  const text = isBody ? t.body : (t.last.text || "这个任务还没有任何消息。");
  const shotsHtml = thumbs(t.id, kind);
  return `<div class="pop-hd">${head}</div><p>${esc(text)}</p>${shotsHtml}` +
    (shotsHtml ? `<div class="pop-tip">点图看大图 · <kbd>←</kbd><kbd>→</kbd> 翻页 · <kbd>Esc</kbd> 关</div>` : "");
}

function showPop(cell) {
  const row = cell.closest(".row[data-id]");
  const t = TASKS.find((x) => x.id === row?.dataset.id);
  if (!t) return;
  popCell = cell;
  pop.innerHTML = popHtml(t, cell.classList.contains("c-body") ? "body" : "last");
  pop.hidden = false;
  // 先落地再量：卡片高度取决于文字长短，量不到就没法决定往下弹还是往上弹。
  const c = cell.getBoundingClientRect(), w = win.getBoundingClientRect(), r = pop.getBoundingClientRect();
  const left = Math.min(Math.max(c.left - 12, w.left + 8), Math.max(w.left + 8, w.right - r.width - 8));
  const below = c.bottom + 8;
  const top = below + r.height > w.bottom - 8 ? Math.max(w.top + 8, c.top - r.height - 8) : below;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function hidePop() {
  clearTimeout(popTimer);
  clearTimeout(popHideTimer);
  pop.hidden = true;
  popCell = null;
}

const scheduleHide = () => {
  clearTimeout(popHideTimer);
  popHideTimer = setTimeout(hidePop, POP_GRACE);
};

/* ── 事件 ─────────────────────────────────────────────── */
rowsEl.addEventListener("click", (e) => {
  const row = e.target.closest(".row[data-id]");
  if (!row) return;
  selected = row.dataset.id;
  render();
  setSpread(false); // 点中某个任务 = 我知道该看谁了，收回原样
});

// 悬浮全文：只在铺开后有意义，收起时这两列宽度是 0，压根指不到
rowsEl.addEventListener("mouseover", (e) => {
  const cell = e.target.closest(".c-body, .c-last");
  if (!spread || !cell) return;
  if (!lb.hidden) return; // 大图开着的时候，卡片不该在它背后偷偷弹出来
  clearTimeout(popHideTimer);
  if (cell === popCell) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => showPop(cell), POP_DELAY);
});

rowsEl.addEventListener("mouseout", (e) => {
  const cell = e.target.closest(".c-body, .c-last");
  if (!cell) return;
  clearTimeout(popTimer);
  if (cell === popCell && !cell.contains(e.relatedTarget)) scheduleHide();
});

pop.addEventListener("mouseenter", () => clearTimeout(popHideTimer));
pop.addEventListener("mouseleave", scheduleHide);
// 列表滚动 / 页面滚动时卡片会跟格子脱节，直接关掉（capture 才收得到 .tree 的滚动）
window.addEventListener("scroll", hidePop, true);

// 缩略图在悬浮卡片和右边详情气泡里都有，用同一个委托开同一个大图
document.addEventListener("click", (e) => {
  const th = e.target.closest(".thumb");
  if (th) openLb(th.dataset.key, Number(th.dataset.i));
});

lb.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-step]");
  if (nav) { stepLb(Number(nav.dataset.step)); return; } // 翻页按钮不关窗
  closeLb();
});

$("filters").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-f]");
  if (!btn) return;
  filter = btn.dataset.f;
  if (!visibleIds().includes(selected)) selected = visibleIds()[0] ?? selected;
  render();
});

$("toggle").addEventListener("click", () => setSpread(!spread));
$("scrim").addEventListener("click", () => setSpread(false));
$("ruler").addEventListener("change", drawRuler);
window.addEventListener("resize", drawRuler);

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // 大图开着的时候它吃掉所有键：Esc 只关大图，不顺手把侧边栏也收了
  if (!lb.hidden) {
    e.preventDefault();
    if (e.key === "ArrowLeft") stepLb(-1);
    else if (e.key === "ArrowRight") stepLb(1);
    else closeLb();
    return;
  }
  const key = e.key.toLowerCase();
  if (key === "f" || e.key === "\\") { e.preventDefault(); setSpread(!spread); return; }
  if (e.key === "Escape" && !pop.hidden) { e.preventDefault(); hidePop(); return; }
  if (e.key === "Escape" && spread) { e.preventDefault(); setSpread(false); return; }
  if (key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
  if (key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
  if (e.key === "Enter" && spread) { e.preventDefault(); setSpread(false); }
});

render();
// 方便截图 / 分享某个状态：#spread 直接以铺开态打开，#spread-todo 再叠上「需要你处理」筛选。
if (location.hash.startsWith("#spread")) {
  if (location.hash === "#spread-todo") filter = "todo";
  requestAnimationFrame(() => setSpread(true));
}

