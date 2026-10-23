const scenarios = {
  result: {
    time: "12:24",
    previousTime: "12:18",
    user: "补完这几处校验闸后，再跑一遍全量回归。等结果回来再收尾。",
    previousReply: "全量回归已经启动，我会等这一轮的结果，不用你再手动叫我。",
    previousDuration: "18s",
    ordinary: "哨兵结束：全量回归（补完第六处闸之后），退出码 0。命令自己跑完了",
    name: "全量回归（补完第六处闸之后）",
    reason: "全量回归有了新结果，继续处理这个任务。",
    context: "来源：你等待的全量回归。以下内容作为新输入送给 Agent。",
    payload: "Ran 3471 tests in 719.547s\nOK (skipped=1) · SWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log",
    legacyTitle: "哨兵事件",
    legacySummary: "Ran 3471 tests in 719.547s OK (skipped=1) SWEEP_EXIT=0 负载={ 3.80 4.83 16.63 } 全文在 /tmp/kb-sweep5.log",
    count: "1 条事件 → 1 次输入",
    raw: "【哨兵事件 · 全量回归（补完第六处闸之后） (monitorId=ePcGkgxYwEYV)】\nRan 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n负载={ 3.80 4.83 16.63 }\n全文在 /tmp/kb-sweep5.log",
    reply: "<p>收到这轮全量回归结果：<strong>共运行 3471 项测试，整轮通过（跳过 1 项），退出码 0。</strong></p><p>我会据此核对最终改动和提交状态，再完成收尾。</p>",
    duration: "1m 27s",
    tools: ["读取回归日志，核对这轮测试结果", "核对工作区改动与提交状态", "整理最终交付说明"],
    toolCount: 6,
    note: "本轮 578.87M",
  },
  ended: {
    time: "12:13",
    previousTime: "12:12",
    user: "提交前那一遍全量还在跑，等它真正收尾之后再提交。",
    previousReply: "当前零红、负载 6，没有残留进程。继续等提交前那一轮回归收尾。",
    previousDuration: "40s",
    ordinary: "哨兵已起：全量回归（补完第六处闸之后）",
    name: "全量回归（清静机器上的提交前那一遍）",
    reason: "哨兵已结束，唤起会话继续处理。",
    context: "以下结束通知作为新输入送给 Agent，由它核对与当前任务的关系。",
    payload: "哨兵 bZMEcdQ29utf 已结束\n退出码 0 · 命令自己跑完了",
    meaning: "命令结束 ≠ 任务完成",
    legacyTitle: "哨兵结束",
    legacySummary: "退出码 0。命令自己跑完了",
    count: "1 条通知 → 1 次输入",
    raw: "【哨兵结束 · 全量回归（清静机器上的提交前那一遍） (monitorId=bZMEcdQ29utf)】\n退出码 0。命令自己跑完了",
    reply: "<p>刚才这条是<strong>旧哨兵的结束通知，不是新结果。</strong></p><p>提交前那一遍全量还在跑；当前零红、机器干净。等它收尾后我再提交。</p>",
    duration: "40s",
    tools: ["核对结束通知对应的哨兵", "检查当前回归进程与日志", "继续等待提交前那一轮结果"],
    toolCount: 3,
    note: "继续等待结果",
  },
  batch: {
    time: "12:24",
    previousTime: "12:18",
    user: "跑完全量回归，结果和退出状态一起核对，确认后再收尾。",
    previousReply: "已经开始等待全量回归。结果会作为自动输入回来，我再继续处理。",
    previousDuration: "18s",
    ordinary: "哨兵已起：全量回归（补完第六处闸之后）",
    name: "全量回归（补完第六处闸之后）",
    reason: "回归结果和结束通知一起送达，继续核对。",
    context: "会话等待期间收到两条事件，合成一次输入，不重复唤起。",
    payload: "[结果] Ran 3471 tests · OK (skipped=1)\n[结束] SWEEP_EXIT=0 · 命令自己跑完了",
    legacyTitle: "哨兵事件",
    legacySummary: "[结果] Ran 3471 tests · OK (skipped=1)；[结束] SWEEP_EXIT=0 · 命令自己跑完了",
    count: "2 条事件 → 1 次输入",
    raw: "【哨兵事件 · 全量回归（补完第六处闸之后） (monitorId=ePcGkgxYwEYV)】\nRan 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log\n\n【哨兵结束 · 全量回归（补完第六处闸之后） (monitorId=ePcGkgxYwEYV)】\n退出码 0。命令自己跑完了",
    reply: "<p>收到合并输入中的<strong>回归结果和退出状态</strong>，这轮只继续处理一次。</p><p>共运行 3471 项测试，整轮通过（跳过 1 项），退出码 0。我会再核对最终改动，确认后完成收尾。</p>",
    duration: "1m 27s",
    tools: ["核对合并输入里的测试结果", "核对同一轮命令的退出状态", "检查最终改动与交付状态"],
    toolCount: 6,
    note: "两条事件 · 一轮回复",
  },
};

const params = new URLSearchParams(window.location.search);
let activeScenario = Object.hasOwn(scenarios, params.get("scenario")) ? params.get("scenario") : "result";
let activeView = params.get("view") === "before" ? "before" : "after";
let activeTheme = params.get("theme") === "dark" ? "dark" : "light";
const conversation = document.getElementById("conversationRows");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function icon(name, className = "") {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

function agentMessage({ text, time, duration, responding = false, tools = [], toolCount = 0, note = "" }) {
  return `<article class="agent-row" aria-label="${responding ? "Agent 对本次输入的回复" : "上一轮 Agent 回复"}">
    <span class="avatar" aria-hidden="true">C</span>
    <div class="agent-content">
      <header class="agent-meta"><strong>claude@nodemach</strong><span class="model-name">claude-opus-5 · xhigh</span><time datetime="2026-10-21T${time}:00+08:00">${time}</time><span>· ${duration}</span>${responding && activeView === "after" ? '<span class="reply-badge">回复这次自动输入</span>' : ""}</header>
      ${tools.length ? `<details class="execution-details"><summary>${icon("chevron")}执行过程 · ${toolCount} 工具</summary><ol>${tools.map((tool) => `<li>${escapeHtml(tool)}</li>`).join("")}</ol></details>` : ""}
      <div class="agent-copy">${text}</div>
      ${note ? `<div class="agent-tools"><span>${icon("check")}${escapeHtml(note)}</span><span>示例回复</span></div>` : ""}
    </div>
  </article>`;
}

function automaticInput(scenario) {
  return `<div class="input-row">
    <article class="input-message" aria-label="ash 自动输入">
      <header class="message-meta"><strong>ash</strong><span class="auto-label">${icon("input")}自动输入</span><time datetime="2026-10-21T${scenario.time}:00+08:00">${scenario.time}</time></header>
      <div class="input-bubble">
        <div class="input-body">
          <div class="source-line">${icon("input")}哨兵触发<span>/</span>${escapeHtml(scenario.name)}</div>
          <h3 class="input-reason">${escapeHtml(scenario.reason)}</h3>
          <p class="input-context">${escapeHtml(scenario.context)}</p>
          <div class="input-payload"><p class="payload-label">${icon("arrow")}送给 Agent 的内容摘要</p><pre class="payload-lines">${escapeHtml(scenario.payload)}</pre></div>
          ${scenario.meaning ? `<span class="event-meaning">${escapeHtml(scenario.meaning)}</span>` : ""}
        </div>
        <footer class="input-footer"><span class="delivery">${icon("check")}已送达 Agent</span><span>${escapeHtml(scenario.count)}</span></footer>
        <details class="input-raw"><summary>${icon("chevron")}查看完整输入与来源</summary><pre>${escapeHtml(scenario.raw)}</pre></details>
      </div>
    </article>
    <span class="avatar auto-avatar" aria-hidden="true">${icon("input")}</span>
  </div>
  <div class="response-link" aria-hidden="true">${icon("arrow")}这条输入唤起了下面这一轮</div>`;
}

function legacyInput(scenario) {
  return `<article class="legacy-input" aria-label="现状中的唤起输入">${icon("info")}
    <div><p class="legacy-title"><strong>${scenario.legacyTitle}</strong> · ${escapeHtml(scenario.name)} (monitorId=${activeScenario === "ended" ? "bZMEcdQ29utf" : "ePcGkgxYwEYV"}) ${escapeHtml(scenario.legacySummary)} <time>10/21 ${scenario.time}</time></p>
    <details class="legacy-raw"><summary>查看完整内容</summary><pre>${escapeHtml(scenario.raw)}</pre></details></div>
  </article>`;
}

function updateLocation() {
  const nextParams = new URLSearchParams({ scenario: activeScenario, view: activeView, theme: activeTheme });
  try {
    window.history.replaceState(null, "", `${window.location.pathname}?${nextParams}${window.location.hash}`);
  } catch {}
}

function render() {
  const scenario = scenarios[activeScenario];
  conversation.innerHTML = `<div class="day-divider">2026 年 10 月 21 日</div>
    <article class="human-row" aria-label="用户输入"><div class="human-message"><header class="message-meta"><strong>你</strong><time datetime="2026-10-21T${scenario.previousTime}:00+08:00">${scenario.previousTime}</time></header><div class="human-bubble">${escapeHtml(scenario.user)}</div></div><span class="avatar" aria-hidden="true">你</span></article>
    ${agentMessage({ text: `<p>${escapeHtml(scenario.previousReply)}</p>`, time: scenario.previousTime, duration: scenario.previousDuration })}
    <div class="ordinary-event" aria-label="普通哨兵记录，样式不变">${icon("info")}<p>${escapeHtml(scenario.ordinary)}<time>10/21 ${scenario.time}</time></p></div>
    <section class="auto-turn" aria-label="一次自动输入及其回复">
      ${activeView === "after" ? automaticInput(scenario) : legacyInput(scenario)}
      ${agentMessage({ text: scenario.reply, time: scenario.time, duration: scenario.duration, responding: true, tools: scenario.tools, toolCount: scenario.toolCount, note: scenario.note })}
    </section>`;

  document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === activeView)));
  document.querySelectorAll("[data-scenario]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scenario === activeScenario)));
  document.getElementById("viewDescription").textContent = activeView === "after" ? "推荐方案 · 自动输入与回复的因果关系" : "现状模拟 · 唤起输入与普通通知过于相似";
  updateLocation();
}

function renderTheme() {
  document.documentElement.dataset.theme = activeTheme;
  const themeButton = document.getElementById("themeButton");
  themeButton.setAttribute("aria-label", activeTheme === "light" ? "切换到深色模式" : "切换到浅色模式");
  themeButton.innerHTML = icon(activeTheme === "light" ? "moon" : "sun");
  updateLocation();
}

document.querySelectorAll("[data-scenario]").forEach((button) => button.addEventListener("click", () => {
  activeScenario = button.dataset.scenario;
  render();
}));

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  activeView = button.dataset.view;
  render();
}));

document.getElementById("themeButton").addEventListener("click", () => {
  activeTheme = activeTheme === "light" ? "dark" : "light";
  renderTheme();
});

render();
renderTheme();
