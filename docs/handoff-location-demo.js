const hosts = [
  { id: "local", name: "本机", detail: "fjh’s MacBook · ~/code/harness", path: "~/code/harness", online: true, kind: "电脑" },
  { id: "mini", name: "Mac mini", detail: "工作室节点 · ~/workspace/harness", path: "~/workspace/harness", online: true, kind: "远程" },
  { id: "windows", name: "Windows 工作站", detail: "Build tower · D:\\ai_workspace\\harness", path: "D:\\ai_workspace\\harness", online: true, kind: "远程" },
  { id: "devbox", name: "devbox", detail: "SSH · /srv/repos/harness", path: "/srv/repos/harness", online: false, kind: "离线" },
];

const hostSvg = `
  <svg viewBox="0 0 22 22" aria-hidden="true">
    <rect x="3.5" y="4" width="15" height="10.5" rx="2"></rect>
    <path d="M8 18h6M11 14.5V18"></path>
  </svg>`;

const state = {
  location: "local",
  destination: null,
  running: true,
  transferCount: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const locationButton = $("#locationButton");
const locationMenu = $("#locationMenu");
const hostList = $("#hostList");
const handoffScrim = $("#handoffScrim");
const connectionsScrim = $("#connectionsScrim");
const reviewView = $("#reviewView");
const progressView = $("#progressView");
const toast = $("#toast");
let toastTimer = null;
let transferTimer = null;
let remoteTimer = null;

function hostById(id) {
  return hosts.find((host) => host.id === id);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function renderHosts() {
  hostList.innerHTML = hosts.map((host) => `
    <button class="host-option${host.id === state.location ? " current" : ""}" type="button" data-host="${host.id}" ${host.online ? "" : "disabled"}>
      <span class="host-icon">${hostSvg}</span>
      <span class="host-copy"><b>${host.name}</b><small>${host.detail}</small></span>
      ${host.id === state.location ? '<span class="host-check">✓</span>' : `<span class="host-tag">${host.kind}</span>`}
    </button>`).join("");

  $$(".host-option").forEach((button) => {
    button.addEventListener("click", () => selectDestination(button.dataset.host));
  });
}

function renderConnections() {
  $("#connectionList").innerHTML = hosts.slice(1).map((host) => `
    <div class="connection-row">
      <span class="host-icon">${hostSvg}</span>
      <div><b>${host.name}</b><small>${host.detail} · 项目 harness 已匹配</small></div>
      <span class="connection-state${host.online ? "" : " offline"}">${host.online ? "在线" : "离线"}</span>
    </div>`).join("");
}

function toggleLocationMenu(force) {
  const shouldOpen = force ?? locationMenu.hidden;
  locationMenu.hidden = !shouldOpen;
  locationButton.setAttribute("aria-expanded", String(shouldOpen));
  if (shouldOpen) renderHosts();
}

function setExecutionState(mode) {
  const waiting = mode === "waiting";
  state.running = !waiting;
  $("#executionState").classList.toggle("is-waiting", waiting);
  $("#executionStateText").textContent = waiting ? "等待你的输入" : "正在执行";
  $(".task-row.active .task-state").className = `task-state ${waiting ? "is-paused" : "is-running"}`;
  $("#taskLocationMeta").textContent = `${waiting ? "等待输入" : "运行于"} · ${hostById(state.location).name}`;
}

function updateLocationUI(current) {
  const remote = current.id !== "local";
  $("#executionBanner").classList.toggle("is-remote", remote);
  $("#executionHostName").textContent = current.name;
  $("#executionDescription").textContent = remote
    ? `远程代码位于 ${current.path}，对话和执行记录持续同步回来`
    : "对话、工具记录和执行进度会实时同步到这个页面";
  $("#locationButtonText").textContent = remote ? "切换或移回本机…" : "移至其他主机…";
  $("#composerRoute").classList.toggle("is-remote", remote);
  $("#composerRouteText").textContent = remote
    ? `这条消息将发送给 ${current.name} 上的 Codex`
    : "这条消息将在本机执行";
  $("#composerSyncText").textContent = "上下文已同步";
  $("#syncStatus").textContent = "实时";
  $("#lastSyncLabel").textContent = "刚刚更新";
  $("#workHostLabel").textContent = current.name;
}

function appendSyncedContext(previous, current) {
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const remote = current.id !== "local";
  const message = remote
    ? `已经在 ${current.name} 的匹配工作区接上进度。我会继续验证组合筛选；这里显示的是远程正在使用的同一份上下文。`
    : `已经把任务接回本机。刚才在 ${previous.name} 产生的对话、命令记录和 Diff 摘要都保留在当前时间线中。`;
  const activity = remote ? `
    <div class="sync-card">
      <div class="sync-card-head"><span></span><b>远程活动实时同步</b><small class="remote-sync-state">同步中</small></div>
      <div class="sync-activity">
        <span><i>✓</i>恢复 worktree 和聊天上下文</span>
        <span><i>✓</i>读取筛选状态与查询参数</span>
        <span class="is-live remote-live-row"><i></i><span>正在运行组合筛选回归测试</span></span>
      </div>
      <div class="diff-strip"><b>远程 Diff</b><span>3 files</span><span class="plus">+84</span><span class="minus">−12</span><span>刚刚同步</span></div>
    </div>` : `
    <div class="sync-card">
      <div class="sync-card-head"><span></span><b>上下文已完整接回</b><small>已同步</small></div>
      <div class="sync-activity">
        <span><i>✓</i>远程对话与工具记录已保留</span>
        <span><i>✓</i>Git 状态已回到本机工作区</span>
      </div>
      <div class="diff-strip"><b>连续历史</b><span>${state.transferCount} 次位置切换</span><span>没有创建副本</span></div>
    </div>`;

  $("#chatFeed").insertAdjacentHTML("beforeend", `
    <div class="location-event dynamic-handoff-entry" role="status">
      <span class="event-line"></span>
      <div class="event-token"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h3A2.5 2.5 0 0 1 12 5.5V7h1.5A2.5 2.5 0 0 1 16 9.5v5A2.5 2.5 0 0 1 13.5 17h-3A2.5 2.5 0 0 1 8 14.5V13H6.5A2.5 2.5 0 0 1 4 10.5v-5ZM6.5 4A1.5 1.5 0 0 0 5 5.5v5A1.5 1.5 0 0 0 6.5 12H8V9.5A2.5 2.5 0 0 1 10.5 7H11V5.5A1.5 1.5 0 0 0 9.5 4h-3Z"/></svg></div>
      <div><b>聊天已从${previous.name}移至${current.name}</b><small>同一聊天 · Git 状态已同步 · ${time}</small></div>
    </div>
    <article class="message agent-message synced-context dynamic-handoff-entry">
      <div class="avatar agent-avatar" aria-hidden="true"><span></span><span></span></div>
      <div class="message-body">
        <div class="message-meta">Codex <span class="remote-badge">${current.name}</span><time>${time}</time></div>
        <div class="agent-copy">${message}</div>
        ${activity}
      </div>
    </article>`);

  const chat = $(".chat");
  requestAnimationFrame(() => chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" }));
  clearTimeout(remoteTimer);
  if (remote) {
    remoteTimer = setTimeout(() => {
      const card = $$(".synced-context").at(-1);
      if (!card || state.location !== current.id) return;
      card.querySelector(".remote-sync-state").textContent = "已同步";
      card.querySelector(".remote-live-row i").textContent = "✓";
      card.querySelector(".remote-live-row").classList.remove("is-live");
      card.querySelector(".remote-live-row span").textContent = "组合筛选回归测试已通过";
      $("#lastSyncLabel").textContent = "测试结果刚刚同步";
      setExecutionState("waiting");
      showToast(`${current.name} 已完成当前步骤，可以继续追问`);
    }, 2600);
  }
}

function selectDestination(id) {
  if (id === state.location) {
    toggleLocationMenu(false);
    showToast(`聊天已经在${hostById(id).name}运行`);
    return;
  }
  const destination = hostById(id);
  if (!destination?.online) {
    showToast(`${destination?.name ?? "目标主机"}当前离线`);
    return;
  }
  state.destination = id;
  toggleLocationMenu(false);
  openReview();
}

function openReview() {
  const source = hostById(state.location);
  const destination = hostById(state.destination);
  $("#sourceName").textContent = source.name;
  $("#sourcePath").textContent = source.path;
  $("#destinationName").textContent = destination.name;
  $("#destinationPath").textContent = destination.path;
  $("#progressTitle").textContent = `正在移至 ${destination.name}`;
  $("#finalStepHost").textContent = destination.name;
  $("#worktreeLabel").textContent = state.transferCount > 0 && state.destination !== "local" ? "复用原工作区" : "创建或复用工作区";
  $("#worktreePath").textContent = state.destination === "windows"
    ? "D:\\ai_workspace\\.worktrees\\filters-v2"
    : state.destination === "local" ? "本地检出 · 当前分支" : "…/.worktrees/filters-v2";
  $("#interruptNote").hidden = !state.running;
  reviewView.hidden = false;
  progressView.hidden = true;
  handoffScrim.hidden = false;
  $("#startHandoffButton").focus();
}

function closeHandoff() {
  if (!progressView.hidden) return;
  handoffScrim.hidden = true;
  state.destination = null;
  locationButton.focus();
}

function startHandoff() {
  if (!state.destination || transferTimer) return;
  const steps = $$("#progressSteps li");
  reviewView.hidden = true;
  progressView.hidden = false;
  steps.forEach((step) => step.classList.remove("active", "done"));
  let index = 0;
  const advance = () => {
    if (index > 0) {
      steps[index - 1].classList.remove("active");
      steps[index - 1].classList.add("done");
    }
    if (index < steps.length) {
      steps[index].classList.add("active");
      index += 1;
      transferTimer = setTimeout(advance, 560);
      return;
    }
    transferTimer = setTimeout(completeHandoff, 420);
  };
  advance();
}

function completeHandoff() {
  clearTimeout(transferTimer);
  transferTimer = null;
  const previous = hostById(state.location);
  state.location = state.destination;
  state.destination = null;
  state.transferCount += 1;
  const current = hostById(state.location);

  updateLocationUI(current);
  setExecutionState(current.id === "local" ? "waiting" : "running");
  $(".work-card-head b").textContent = "进度已保存";
  $(".live-dot").style.animation = "none";
  $(".live-dot").style.background = "var(--green)";
  appendSyncedContext(previous, current);
  handoffScrim.hidden = true;
  renderHosts();
  showToast(`已移至${current.name}，仍是同一个聊天`);
  setTimeout(() => locationButton.focus(), 0);
}

function resetDemo() {
  clearTimeout(transferTimer);
  clearTimeout(remoteTimer);
  transferTimer = null;
  remoteTimer = null;
  state.location = "local";
  state.destination = null;
  state.running = true;
  state.transferCount = 0;
  handoffScrim.hidden = true;
  connectionsScrim.hidden = true;
  toggleLocationMenu(false);
  updateLocationUI(hostById("local"));
  setExecutionState("running");
  $(".work-card-head b").textContent = "正在处理";
  $(".live-dot").removeAttribute("style");
  $$(".dynamic-handoff-entry").forEach((entry) => entry.remove());
  renderHosts();
  showToast("演示已重置");
}

function openConnections() {
  toggleLocationMenu(false);
  renderConnections();
  connectionsScrim.hidden = false;
  $(".connections-close").focus();
}

function closeConnections() {
  connectionsScrim.hidden = true;
}

locationButton.addEventListener("click", () => toggleLocationMenu());
$("#startHandoffButton").addEventListener("click", startHandoff);
$("#resetButton").addEventListener("click", resetDemo);
$("#connectionsButton").addEventListener("click", openConnections);
$("#manageConnectionsButton").addEventListener("click", openConnections);
$$('.modal-close').forEach((button) => button.addEventListener("click", closeHandoff));
$$('.connections-close').forEach((button) => button.addEventListener("click", closeConnections));

document.addEventListener("click", (event) => {
  if (!locationMenu.hidden && !event.target.closest(".execution-actions")) toggleLocationMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!connectionsScrim.hidden) closeConnections();
  else if (!handoffScrim.hidden) closeHandoff();
  else toggleLocationMenu(false);
});

handoffScrim.addEventListener("mousedown", (event) => {
  if (event.target === handoffScrim) closeHandoff();
});
connectionsScrim.addEventListener("mousedown", (event) => {
  if (event.target === connectionsScrim) closeConnections();
});

renderHosts();
renderConnections();
