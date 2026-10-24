const select = (selector) => document.querySelector(selector);
const selectAll = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const sampleTitles = [
  "独立审查：24 项定向行为检查及三包类型和机械检查",
  "最小复现：旧接力协议的审查等待消费",
  "最小复现：暂停与已接受审查答复的重投",
  "最小复现：自动验收后工作流命令能否继续",
  "加强复现：真实暂停分组 HTTP 与答复起跑交错",
  "复现补正：合法的人工关口 → 验证 → 验收 → 命令流程",
  "补足自动验收候选的流程与退出前状态证据",
  "定位验收候选夹具差异，记录实际收尾工作流",
  "确认复现：就地验证自动验收后跳过命令",
  "补足修改过的证据可用性、生命周期和验收站回归缺口",
];
const nonzeroIndexes = new Set([3, 5, 6]);
const state = { messages: [], view: "after", mixed: false, filter: "all", panelOpen: false, serial: 0, pendingCancel: null };
let toastTimer;

function monitorMessage(index) {
  const exitCode = nonzeroIndexes.has(index % 10) ? 1 : 0;
  const title = sampleTitles[index % sampleTitles.length];
  const batch = index >= 10 ? ` · 第 ${Math.floor(index / 10) + 1} 组` : "";
  const serial = ++state.serial;
  return {
    id: `monitor-${serial}`, kind: "monitor", title: title + batch, exitCode,
    time: `16:${String(30 + index % 30).padStart(2, "0")}`,
    text: `【哨兵结束】${title}${batch}\nmonitorId=demo-monitor-${serial}\n退出码 ${exitCode}。命令自己跑完了。\n${exitCode ? "有检查未通过，请结合完整日志确认原因。" : "PASS · 定向行为检查执行完成。"}\n本条是演示数据，不对应真实测试证据。`,
  };
}

function userMessage(title) {
  return { id: `user-${++state.serial}`, kind: "user", title, text: title, time: "16:44" };
}

function loadScenario(count) {
  state.panelOpen = false;
  state.messages = Array.from({ length: count }, (_, index) => {
    if (state.mixed && (index === 1 || index === 7)) {
      return userMessage(index === 1 ? "先别改代码，等全部回归结果回来再给结论。" : "把未通过的检查单独列出来，说明是否影响验收。");
    }
    return monitorMessage(index);
  });
  state.filter = "all";
  select("#simulation-history").replaceChildren();
  render();
}

function counts() {
  const messages = state.messages;
  return {
    all: messages.length,
    user: messages.filter((message) => message.kind === "user").length,
    monitor: messages.filter((message) => message.kind === "monitor").length,
    attention: messages.filter((message) => message.exitCode > 0).length,
  };
}

function firstUserId() {
  return state.messages.find((message) => message.kind === "user")?.id;
}

function exitLabel(message) {
  return message.kind === "monitor"
    ? `<span class="row-exit${message.exitCode ? " attention" : ""}">exit ${message.exitCode}</span>`
    : "<span class=\"row-exit\">你追加的消息</span>";
}

function inlineRow(message) {
  const personal = message.kind === "user";
  return `<div class="inline-row">${icon(personal ? "message" : "pulse")}
    <div class="inline-copy"><div class="inline-source">${personal ? "我的消息 · 当前回合结束后发送" : "哨兵输入 · 任务空闲后唤醒"} <span>@codex</span></div><div class="inline-title" title="${escapeHtml(message.title)}">${escapeHtml(message.title)}</div></div>
    <div class="inline-actions">${message.id === firstUserId() ? `<button type="button" data-action="steer" data-id="${message.id}">引导会话</button>` : ""}
    <button type="button" class="icon-button" data-action="${personal ? "withdraw" : "cancel"}" data-id="${message.id}" aria-label="${personal ? "撤回消息" : "取消这次唤醒"}：${escapeHtml(message.title)}">${icon(personal ? "return" : "close")}</button></div></div>`;
}

function renderTray() {
  const total = counts();
  const tray = select("#queue-tray");
  if (!total.all) {
    tray.replaceChildren();
    return;
  }
  if (state.view === "before" || total.all <= 2) {
    tray.innerHTML = `<div class="inline-list${state.view === "before" ? " legacy-list" : ""}">${state.messages.map(inlineRow).join("")}</div>`;
    return;
  }
  tray.innerHTML = `<section class="queue-card${state.panelOpen ? " is-expanded" : ""}" aria-label="${state.panelOpen ? "已展开" : "已折叠"}的排队输入">
    <div class="queue-summary"><span class="stack-icon">${icon("stack")}</span><div class="summary-copy"><div class="summary-title">排队输入 <span class="queue-count">${total.all}</span></div><div class="summary-meta"><span>${total.user ? `我的消息 ${total.user} · ` : ""}哨兵 ${total.monitor}</span><span>·</span><span>等待当前一轮结束</span></div></div>
    ${total.attention ? `<button type="button" class="attention-button" data-open="attention" aria-label="查看 ${total.attention} 条退出码非零的输入">${icon("alert")}${total.attention} 条需留意</button>` : ""}
    <button type="button" class="queue-open" id="open-panel" data-open="all" aria-expanded="${state.panelOpen}" aria-controls="queue-details">${state.panelOpen ? "收起列表" : `展开全部 ${total.all} 条`}${icon("chevron")}</button></div>
    ${state.panelOpen ? `<div class="queue-details" id="queue-details"><div class="queue-filters" id="queue-filters" role="group" aria-label="筛选排队输入"></div><div class="panel-list" id="panel-list" tabindex="0" aria-label="排队输入列表"></div><footer class="queue-footer"><span class="order-dot"></span>筛选只改变查看范围，不改变投递顺序。</footer></div>`
      : `<div class="preview-rows">${state.messages.slice(0, 2).map((message, index) => `<button type="button" class="preview-row" data-open="all" data-reveal="${message.id}" aria-label="查看第 ${index + 1} 条输入：${escapeHtml(message.title)}"><span class="queue-position">${index + 1}</span>${icon(message.kind === "user" ? "message" : "pulse")}<span class="preview-origin">${message.kind === "user" ? "我的消息" : "哨兵"}</span><span class="preview-title">${escapeHtml(message.title)}</span>${exitLabel(message)}</button>`).join("")}</div><div class="queue-more">另有 ${total.all - 2} 条已收起 · 按原顺序等待处理</div>`}</section>`;
}

function matchesFilter(message) {
  return state.filter === "all" || message.kind === state.filter || (state.filter === "attention" && message.exitCode > 0);
}

function panelRow(message) {
  const personal = message.kind === "user";
  const position = state.messages.indexOf(message) + 1;
  return `<article class="panel-row" data-message="${message.id}">
    <div class="panel-row-header"><span class="queue-position">#${position}</span>${icon(personal ? "message" : "pulse")}<span>${personal ? "我的消息" : "哨兵输入"}</span><span>→ @codex</span><time>${message.time}</time></div>
    <h4>${escapeHtml(message.title)}</h4><div class="panel-row-bottom">${exitLabel(message)}<span>${message.id === firstUserId() ? `<button type="button" class="row-action steer" data-action="steer" data-id="${message.id}">引导会话</button>` : ""}<button type="button" class="row-action" data-action="${personal ? "withdraw" : "cancel"}" data-id="${message.id}">${personal ? "撤回到输入框" : "取消这次唤醒"}</button></span></div>
    <details class="message-details"><summary>查看完整输入</summary><pre>${escapeHtml(message.text)}</pre></details></article>`;
}

function panelSnapshot() {
  const list = select("#panel-list");
  return {
    scrollTop: list?.scrollTop ?? 0,
    expandedIds: [...(list?.querySelectorAll("details[open]") ?? [])].map((details) => details.closest("[data-message]").dataset.message),
  };
}

function renderPanel(snapshot = panelSnapshot()) {
  const list = select("#panel-list");
  const total = counts();
  select("#queue-filters").innerHTML = [["all", "全部"], ["user", "我的消息"], ["monitor", "哨兵"], ["attention", "需留意"]]
    .map(([key, label]) => `<button type="button" data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span>${total[key]}</span></button>`).join("");
  const messages = state.messages.filter(matchesFilter);
  list.innerHTML = messages.length ? messages.map(panelRow).join("") : '<p class="empty-filter">这个分类下没有等待输入。</p>';
  snapshot.expandedIds.forEach((messageId) => {
    const details = list.querySelector(`[data-message="${messageId}"] details`);
    if (details) details.open = true;
  });
  fitPanel();
  list.scrollTop = snapshot.scrollTop;
}

function fitPanel() {
  if (!state.panelOpen) return;
  const card = select(".queue-card");
  const list = select("#panel-list");
  if (!card || !list) return;
  list.style.maxHeight = "";
  const preferredHeight = parseFloat(getComputedStyle(list).maxHeight);
  const cardHeight = card.getBoundingClientRect().height;
  const composerHeight = select(".composer-zone").getBoundingClientRect().height - cardHeight;
  const availableHeight = select(".task-window").getBoundingClientRect().height - select(".task-header").getBoundingClientRect().height - composerHeight - 100;
  const chromeHeight = cardHeight - list.getBoundingClientRect().height;
  list.style.maxHeight = `${Math.max(64, Math.min(preferredHeight, availableHeight - chromeHeight))}px`;
}

function render() {
  const focused = document.activeElement;
  const focusKey = focused?.dataset.filter;
  const focusAction = focused?.dataset.action;
  const focusId = focused?.dataset.id;
  const focusedInQueue = !!focused?.closest("#queue-anchor");
  const focusElementId = focused?.id;
  const focusMessageId = focused?.closest("[data-message]")?.dataset.message;
  const snapshot = panelSnapshot();
  if (state.messages.length <= 2) state.panelOpen = false;
  renderTray();
  if (state.panelOpen) {
    renderPanel(snapshot);
  }
  if (focusedInQueue) {
    const target = focusElementId ? document.getElementById(focusElementId)
      : focusKey ? select(`[data-filter="${focusKey}"]`)
      : focusAction ? select(`[data-action="${focusAction}"][data-id="${focusId}"]`)
      : focusMessageId ? select(`[data-message="${focusMessageId}"] summary`) : null;
    (target ?? select("#open-panel") ?? select("#message-input")).focus({ preventScroll: true });
  }
  document.body.classList.toggle("before-mode", state.view === "before");
  selectAll("[data-count]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.count) === state.messages.length)));
  selectAll("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
  select("#consume-button").disabled = !state.messages.length;
  select("#queue-footnote").textContent = state.messages.length ? `· 当前有 ${state.messages.length} 条待处理` : "· 暂无排队输入";
  select("#space-caption").textContent = state.view === "before" ? "每条各占一行，对话区被向上挤压" : state.panelOpen ? "队列原位向上展开，输入框留在原处" : "收起时，排队再多也只占固定高度";
  select("#queue-announcement").textContent = `当前有 ${state.messages.length} 条排队输入${counts().attention ? `，其中 ${counts().attention} 条需留意` : ""}。`;
}

function openPanel(filter = "all", revealId = null) {
  if (state.messages.length <= 2) return;
  state.filter = filter;
  state.panelOpen = true;
  render();
  select(filter === "attention" ? ".attention-button" : "#open-panel").focus({ preventScroll: true });
  if (revealId) {
    const row = select(`[data-message="${revealId}"]`);
    if (row) {
      row.querySelector("details").open = true;
      select("#panel-list").scrollTop = row.offsetTop - select("#panel-list").offsetTop;
    }
  }
}

function closePanel(restoreFocus = true) {
  state.panelOpen = false;
  render();
  const openButton = select("#open-panel");
  if (restoreFocus) {
    (openButton ?? select("#message-input")).focus({ preventScroll: true });
  }
}

function toast(message) {
  select("#toast").textContent = message;
  select("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { select("#toast").hidden = true; }, 4200);
}

function removeMessage(messageId) {
  state.messages = state.messages.filter((message) => message.id !== messageId);
  render();
}

function recordSimulation(message) {
  const entry = document.createElement("p");
  entry.textContent = message;
  select("#simulation-history").appendChild(entry);
  while (select("#simulation-history").children.length > 3) select("#simulation-history").firstElementChild.remove();
  select("#chat-scroll").scrollTop = select("#chat-scroll").scrollHeight;
}

function handleMessageAction(action, messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  if (action === "cancel" && message.kind === "monitor") {
    state.pendingCancel = messageId;
    select("#cancel-subject").textContent = message.title;
    select("#cancel-dialog").returnValue = "";
    select("#cancel-dialog").showModal();
  } else if (action === "withdraw" && message.kind === "user") {
    const input = select("#message-input");
    input.value = input.value.trim() ? `${input.value}\n\n${message.text}` : message.text;
    removeMessage(messageId);
    select("#send-button").disabled = !input.value.trim();
    input.focus();
    toast("已撤回到输入框，保留了原有草稿。仅演示。");
  } else if (action === "steer" && messageId === firstUserId()) {
    removeMessage(messageId);
    recordSimulation(`演示引导会话：${message.title}`);
    toast("已模拟引导到当前会话，未发送真实请求。");
  }
}

selectAll("[data-count]").forEach((button) => button.addEventListener("click", () => loadScenario(Number(button.dataset.count))));
selectAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  state.panelOpen = false;
  state.view = button.dataset.view;
  render();
}));
select("#mixed-toggle").addEventListener("change", (event) => {
  state.mixed = event.target.checked;
  loadScenario(state.messages.length);
});
select("#queue-anchor").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.open) {
    if (state.panelOpen && button.id === "open-panel") closePanel();
    else openPanel(button.dataset.open, button.dataset.reveal);
  } else if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    renderPanel();
    select("#panel-list").scrollTop = 0;
    select(`[data-filter="${state.filter}"]`).focus({ preventScroll: true });
  } else if (button.dataset.action) handleMessageAction(button.dataset.action, button.dataset.id);
});
window.addEventListener("resize", fitPanel);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.panelOpen && !select("#cancel-dialog").open) {
    event.preventDefault();
    closePanel();
  }
});
select("#cancel-dialog").addEventListener("close", () => {
  if (select("#cancel-dialog").returnValue === "cancel" && state.pendingCancel) {
    removeMessage(state.pendingCancel);
    if (state.panelOpen) select("#open-panel").focus({ preventScroll: true });
    else select("#message-input").focus({ preventScroll: true });
    toast("已取消这次唤醒，未停止哨兵。仅演示。");
  }
  state.pendingCancel = null;
});
select("#consume-button").addEventListener("click", () => {
  const message = state.messages[0];
  if (!message) return;
  removeMessage(message.id);
  recordSimulation(`模拟处理了最早一条：${message.title}`);
  toast(`按原顺序处理了 1 条，剩余 ${state.messages.length} 条。仅演示。`);
});
select("#add-button").addEventListener("click", () => {
  state.messages.push(monitorMessage(state.serial));
  render();
  toast("新的哨兵输入已排在队尾，列表不会自动展开。");
});
select("#message-input").addEventListener("input", (event) => { select("#send-button").disabled = !event.target.value.trim(); });
select("#composer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = select("#message-input");
  if (!input.value.trim()) return;
  state.messages.push(userMessage(input.value.trim()));
  input.value = "";
  select("#send-button").disabled = true;
  render();
  toast("消息已加入演示队列，未发送真实请求。");
});

loadScenario(10);
