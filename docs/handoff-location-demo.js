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
  state.running = false;
  state.transferCount += 1;
  const current = hostById(state.location);

  $("#locationButtonText").textContent = current.name;
  $("#headerLocation").textContent = `${current.name} · ${current.path}`;
  $("#taskLocationMeta").textContent = `等待输入 · ${current.name}`;
  $("#workHostLabel").textContent = current.name;
  $(".task-state.active")?.classList.remove("active");
  $(".task-row.active .task-state").className = "task-state is-paused";
  $(".work-card-head b").textContent = "进度已保存";
  $(".live-dot").style.animation = "none";
  $(".live-dot").style.background = "var(--green)";

  const event = $("#locationEvent");
  $("#eventTitle").textContent = `聊天已从${previous.name}移至${current.name}`;
  $("#eventText").textContent = `同一聊天 · Git 状态已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  event.classList.remove("is-hidden");
  handoffScrim.hidden = true;
  renderHosts();
  showToast(`已移至${current.name}，仍是同一个聊天`);
  setTimeout(() => locationButton.focus(), 0);
}

function resetDemo() {
  clearTimeout(transferTimer);
  transferTimer = null;
  state.location = "local";
  state.destination = null;
  state.running = true;
  state.transferCount = 0;
  handoffScrim.hidden = true;
  connectionsScrim.hidden = true;
  toggleLocationMenu(false);
  $("#locationButtonText").textContent = "本机";
  $("#headerLocation").textContent = "本机 · ~/code/harness";
  $("#taskLocationMeta").textContent = "运行于 · 本机";
  $("#workHostLabel").textContent = "本机";
  $(".task-row.active .task-state").className = "task-state is-running";
  $(".work-card-head b").textContent = "正在处理";
  $(".live-dot").removeAttribute("style");
  $("#locationEvent").classList.add("is-hidden");
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
  if (!locationMenu.hidden && !event.target.closest(".run-location-wrap")) toggleLocationMenu(false);
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
