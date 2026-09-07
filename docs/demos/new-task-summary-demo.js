/* 新建任务 —— 「执行摘要条」方案的交互原型。
   要点：页面上没有配置表单，只有一行 chip；所有取值都在浮层里就地改，改完 chip 与
   底下那句人话同步更新。这样默认值全程可见，而首屏不必为它们让出垂直空间。 */

const AGENTS = {
  claude: { label: "claude", profile: "claude@ccb", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  codex: { label: "codex", profile: "codex@cpa", models: ["gpt-5.6-sol", "gpt-5.5", "gpt-5.5-mini"] },
  gemini: { label: "gemini", profile: "gemini@vertex", models: ["gemini-3-pro", "gemini-3-flash"] },
};
const EFFORTS = ["跟随", "低", "中", "高", "极高"];
const BRANCHES = ["main", "develop", "feat/issue-center", "release/2026-09"];
const GROUPS = [
  { id: "", name: "无分组", detail: "" },
  { id: "g1", name: "前端重构", detail: "并行" },
  { id: "g2", name: "日报流水线", detail: "串行" },
];
const PRESETS = [
  { id: "ship", name: "实现 → 审查 → 验收", desc: "改完自动派审，审查通过后停在待验收" },
  { id: "dig", name: "调研 → 实现", desc: "先出方案再动手，中间给你一次拍板机会" },
  { id: "fix", name: "定位 → 修复 → 回归", desc: "带回归验证的问题修复线路" },
];
const LAUNCHES = [
  { id: "run", label: "创建并运行", desc: "立即起跑" },
  { id: "create", label: "只创建", desc: "停在待办，之后手动启动" },
  { id: "once", label: "一次性定时", desc: "到点自动起跑一次" },
  { id: "cron", label: "Cron 定时", desc: "按周期反复起跑" },
];
const LABEL_SUGGESTIONS = ["前端", "重构", "bug", "调研", "紧急"];

const state = {
  mode: "single",
  workflow: "free",
  presetId: "ship",
  exec: {
    single: { agent: "claude", model: "claude-opus-5", effort: "跟随" },
    lead: { agent: "claude", model: "claude-opus-5", effort: "跟随" },
    worker: { agent: "codex", model: "gpt-5.6-sol", effort: "高" },
    reviewer: { agent: "codex", model: "gpt-5.6-sol", effort: "跟随" },
    voiceA: { agent: "claude", model: "claude-opus-5", effort: "跟随" },
    voiceB: { agent: "codex", model: "gpt-5.6-sol", effort: "跟随" },
  },
  review: true,
  rounds: "3",
  gate: true,
  worktree: true,
  base: "main",
  groupId: "",
  labels: [],
  launch: "run",
  body: "",
  attachments: [],
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
};
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const execText = (role) => {
  const cfg = state.exec[role];
  return `${AGENTS[cfg.agent].label} · ${cfg.model}${cfg.effort === "跟随" ? "" : ` · ${cfg.effort}`}`;
};

/* ── 浮层 ────────────────────────────────────────────────────────────── */
const popover = $("popover");
let openAnchor = null;

function closePopover() {
  popover.hidden = true;
  popover.replaceChildren();
  if (openAnchor) openAnchor.setAttribute("aria-expanded", "false");
  openAnchor = null;
}

function openPopover(anchor, title, build) {
  if (openAnchor === anchor) return closePopover();
  closePopover();
  openAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  popover.replaceChildren(el("p", "pop-title", title));
  build(popover);
  popover.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const left = Math.min(Math.max(10, box.left), window.innerWidth - width - 10);
  const below = box.bottom + 6;
  const fitsBelow = below + popover.offsetHeight < window.innerHeight - 10;
  popover.style.left = `${left}px`;
  popover.style.top = fitsBelow ? `${below}px` : `${Math.max(10, box.top - popover.offsetHeight - 6)}px`;
}

document.addEventListener("pointerdown", (event) => {
  if (popover.hidden) return;
  if (popover.contains(event.target) || openAnchor?.contains(event.target)) return;
  closePopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) { event.stopPropagation(); closePopover(); }
});

function pills(host, label, items, current, onPick, mono) {
  const group = el("div", "pop-group");
  if (label) group.append(el("b", null, label));
  const row = el("div", "pop-pills");
  for (const item of items) {
    const value = typeof item === "string" ? item : item.value;
    const text = typeof item === "string" ? item : item.label;
    const pill = el("button", `pop-pill${mono ? " mono" : ""}`, text);
    pill.type = "button";
    pill.setAttribute("aria-pressed", String(value === current));
    pill.onclick = () => { onPick(value); render(); };
    row.append(pill);
  }
  group.append(row);
  host.append(group);
}

function list(host, items, current, onPick) {
  const box = el("div", "pop-list");
  for (const item of items) {
    const button = el("button", "pop-item");
    button.type = "button";
    button.setAttribute("aria-selected", String(item.id === current));
    button.innerHTML = `<span>${item.name}${item.desc ? `<span class="desc">${item.desc}</span>` : ""}</span>`
      + (item.detail ? `<em>${item.detail}</em>` : "") + icon("check");
    button.onclick = () => { onPick(item.id); render(); };
    box.append(button);
  }
  host.append(box);
}

function toggle(host, text, hint, on, onFlip) {
  const button = el("button", "pop-switch");
  button.type = "button";
  button.innerHTML = `<span>${text}${hint ? `<small>${hint}</small>` : ""}</span><span class="ui-toggle${on ? " is-on" : ""}"></span>`;
  button.onclick = () => { onFlip(!on); render(); };
  host.append(button);
}

/* 执行器浮层：三段（智能体 / 模型 / 智能水平）一次看全，点一下就改。
   现在的三段胶囊每段都要再开一层浮层，改一次执行器最多点三次。 */
function executorPopover(role) {
  return (host) => {
    pills(host, "智能体", Object.entries(AGENTS).map(([id, a]) => ({ value: id, label: `${a.label}` })),
      state.exec[role].agent, (value) => {
        state.exec[role].agent = value;
        state.exec[role].model = AGENTS[value].models[0];
        state.exec[role].effort = "跟随";
      });
    pills(host, "模型", AGENTS[state.exec[role].agent].models, state.exec[role].model,
      (value) => { state.exec[role].model = value; }, true);
    pills(host, "智能水平", EFFORTS, state.exec[role].effort, (value) => { state.exec[role].effort = value; });
    host.append(el("p", "pop-hint", `Profile <span class="mono">${AGENTS[state.exec[role].agent].profile}</span> · 换智能体会把模型与智能水平重置为跟随执行器。`));
  };
}

/* ── chip 定义：每种模式只声明自己那几颗 ─────────────────────────────── */
function chipDefs() {
  const worktree = {
    icon: "branch", key: "运行位置",
    value: state.worktree ? `独立 worktree · ${state.base}` : "直接用项目目录",
    off: !state.worktree, title: "运行位置",
    build: (host) => {
      toggle(host, "独立 worktree", "在隔离副本里改动，验收时再合回来", state.worktree, (on) => { state.worktree = on; });
      if (state.worktree) pills(host, "base 分支", BRANCHES, state.base, (value) => { state.base = value; }, true);
    },
  };
  const group = {
    icon: "stack", key: "分组",
    value: GROUPS.find((item) => item.id === state.groupId)?.name ?? "无分组",
    off: !state.groupId, title: "分组",
    build: (host) => list(host, GROUPS.map((item) => ({ ...item, id: item.id })), state.groupId, (id) => { state.groupId = id; }),
  };
  const labels = {
    icon: "tag", key: "标签",
    value: state.labels.length ? state.labels.join("、") : "无",
    off: !state.labels.length, title: "标签",
    build: (host) => {
      const input = el("input", "pop-input");
      input.placeholder = "输入后回车添加…";
      input.onkeydown = (event) => {
        if (event.key !== "Enter" || !input.value.trim()) return;
        event.preventDefault();
        if (!state.labels.includes(input.value.trim())) state.labels.push(input.value.trim());
        render();
      };
      host.append(input);
      pills(host, "常用", [...new Set([...LABEL_SUGGESTIONS, ...state.labels])].map((name) => ({ value: name, label: name })),
        null, (value) => {
          const at = state.labels.indexOf(value);
          if (at >= 0) state.labels.splice(at, 1); else state.labels.push(value);
        });
      if (state.labels.length) host.append(el("p", "pop-hint", `已选：${state.labels.join("、")}（再点一次取消）`));
    },
  };

  if (state.mode === "duet") {
    return [
      { icon: "chat", key: "讨论者 A", value: execText("voiceA"), accent: true, title: "讨论者 A", build: executorPopover("voiceA") },
      { icon: "chat", key: "讨论者 B", value: execText("voiceB"), accent: true, title: "讨论者 B", build: executorPopover("voiceB") },
      {
        icon: "flow", key: "最多轮数", value: state.rounds ? `${state.rounds} 轮` : "不限", title: "轮数与收口",
        build: (host) => {
          pills(host, "最多轮数", [{ value: "", label: "不限" }, ...["1", "2", "3", "5", "8"].map((n) => ({ value: n, label: `${n} 轮` }))],
            state.rounds, (value) => { state.rounds = value; });
          toggle(host, "共识闸门", state.gate ? "达成结论后要你确认才结束" : "达成结论即自动结束", state.gate, (on) => { state.gate = on; });
        },
      },
      labels,
    ];
  }

  if (state.mode === "team") {
    return [
      { icon: "users", key: "调度者", value: execText("lead"), accent: true, title: "调度者执行器", build: executorPopover("lead") },
      { icon: "robot", key: "执行者", value: execText("worker"), accent: true, title: "执行者执行器", build: executorPopover("worker") },
      {
        icon: "check", key: "自动审查", value: state.review ? execText("reviewer") : "关闭", off: !state.review, title: "自动审查",
        build: (host) => {
          toggle(host, "执行者确认完成后自动派审", null, state.review, (on) => { state.review = on; });
          if (state.review) executorPopover("reviewer")(host);
        },
      },
      worktree, group, labels,
    ];
  }

  const preset = PRESETS.find((item) => item.id === state.presetId);
  return [
    {
      icon: "flow", key: "工作方式",
      value: state.workflow === "free" ? "自由工作流" : `起手式 · ${preset.name}`,
      accent: true, title: "工作方式",
      build: (host) => {
        pills(host, null, [{ value: "free", label: "自由工作流" }, { value: "preset", label: "起手式" }],
          state.workflow, (value) => { state.workflow = value; });
        if (state.workflow === "preset") list(host, PRESETS, state.presetId, (id) => { state.presetId = id; });
        else host.append(el("p", "pop-hint", "按需派审和预览，完成后由你统一验收。"));
      },
    },
    { icon: "robot", key: "执行器", value: execText("single"), accent: true, title: "任务执行器", build: executorPopover("single") },
    worktree, group, labels,
  ];
}

/* ── 那句人话：把 chips 翻译成“创建之后会发生什么” ───────────────────── */
function noteText() {
  const where = state.worktree
    ? `在<b>独立 worktree</b>（<span class="mono">${state.base}</span>）里`
    : "<b>直接在项目目录</b>里";
  const start = { run: "创建后立即", create: "创建后停在待办，手动启动时", once: "到设定时间", cron: "每次定时触发时" }[state.launch];
  if (state.mode === "duet") {
    return `${start}由 <b>${execText("voiceA")}</b> 与 <b>${execText("voiceB")}</b> 就这个议题讨论`
      + `${state.rounds ? `最多 <b>${state.rounds} 轮</b>` : "，<b>不限轮数</b>"}；`
      + (state.gate ? "达成结论后需要你确认才收口。" : "达成结论即自动收口。");
  }
  if (state.mode === "team") {
    return `${start}由调度者 <b>${execText("lead")}</b> 拆活派给执行者 <b>${execText("worker")}</b>，${where}进行；`
      + (state.review ? `每个执行者确认完成后自动派 <b>${execText("reviewer")}</b> 审查。` : "<b>不自动派审</b>，完成后直接等你验收。");
  }
  if (state.workflow === "preset") {
    const preset = PRESETS.find((item) => item.id === state.presetId);
    return `${start}按起手式 <b>${preset.name}</b> 自动推进，${where}进行 —— ${preset.desc}。`;
  }
  return `${start}由 <b>${execText("single")}</b> ${where}执行；过程中你可以随时派审或起预览，完成后统一验收。`;
}

/* ── 渲染 ────────────────────────────────────────────────────────────── */
function render() {
  document.querySelectorAll(".composer-modes button").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.mode === state.mode));
  });

  const host = $("chips");
  host.replaceChildren();
  for (const def of chipDefs()) {
    const chip = el("button", `summary-chip${def.off ? " is-off" : ""}${def.accent ? " is-accent" : ""}`);
    chip.type = "button";
    chip.setAttribute("aria-expanded", "false");
    chip.innerHTML = `${icon(def.icon)}<span class="k">${def.key}</span><span class="v">${def.value}</span>${icon("caret", "ic is-caret")}`;
    chip.onclick = () => openPopover(chip, def.title, def.build);
    host.append(chip);
  }

  $("note").innerHTML = noteText();
  const count = state.body.trim().length;
  $("count").textContent = `${count} 字`;
  const attachmentCount = state.attachments.length;
  $("footerHint").textContent = state.mode === "duet"
    ? "讨论不收附件 · ⌘↵ 按当前启动方式创建"
    : `${attachmentCount} 个附件 · ⌘↵ 按当前启动方式创建`;
  const launch = LAUNCHES.find((item) => item.id === state.launch);
  $("launchModeLabel").textContent = launch.label;
  $("submitLabel").textContent = launch.id === "create" ? "创建" : launch.label;
  $("submit").disabled = !(count || (attachmentCount && state.mode !== "duet"));

  const box = $("attachments");
  box.hidden = !attachmentCount || state.mode === "duet";
  box.replaceChildren(...state.attachments.map((name, index) => {
    const item = el("span", "attachment", `${icon("clip")}${name}`);
    const remove = el("button", null, "✕");
    remove.type = "button";
    remove.onclick = () => { state.attachments.splice(index, 1); render(); };
    item.append(remove);
    return item;
  }));
}

/* ── 事件 ────────────────────────────────────────────────────────────── */
let toastTimer = 0;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

document.querySelectorAll(".composer-modes button").forEach((button) => {
  button.onclick = () => {
    if (state.mode === button.dataset.mode) return;
    state.mode = button.dataset.mode;
    closePopover();
    render();
    if (state.body.trim()) toast("已切换模式，正文保留");
  };
});

const body = $("body");
body.oninput = () => {
  const match = /^\s*\/(single|team|duet)\s+([\s\S]*)$/i.exec(body.value);
  if (match) {
    state.mode = match[1].toLowerCase();
    body.value = match[2] ?? "";
    toast(`已切到${{ single: "单任务", team: "团队", duet: "讨论" }[state.mode]}`);
  }
  state.body = body.value;
  render();
};
body.onkeydown = (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !$("submit").disabled) {
    event.preventDefault();
    $("submit").click();
  }
};

$("attach").onclick = () => {
  state.attachments.push(`截图-${state.attachments.length + 1}.png`);
  render();
};

$("launchMode").onclick = () => openPopover($("launchMode"), "启动方式", (host) => {
  list(host, LAUNCHES.map((item) => ({ id: item.id, name: item.label, desc: item.desc })), state.launch,
    (id) => { state.launch = id; });
});

$("submit").onclick = () => {
  closePopover();
  toast(state.launch === "create" ? "任务已创建" : `任务已创建 · ${LAUNCHES.find((i) => i.id === state.launch).label}`);
};

render();

/* demo 便利：`#mode=team&open=2` 直接进到某个模式并展开第 N 颗 chip，
   方便逐个状态取证，不必驱动 CDP 点击。 */
const seed = new URLSearchParams(location.hash.slice(1));
if (["single", "team", "duet"].includes(seed.get("mode"))) {
  state.mode = seed.get("mode");
  render();
}
const openAt = Number(seed.get("open"));
if (openAt > 0) $("chips").children[openAt - 1]?.click();
