const taskPrompt = document.querySelector("#taskPrompt");
const charCount = document.querySelector("#charCount");
const modeButtons = [...document.querySelectorAll(".composer-tabs [data-mode]")];
const workflowButtons = [...document.querySelectorAll(".workflow-tabs button")];
const executorBlock = document.querySelector("#executorBlock");
const presetRoute = document.querySelector("#presetRoute");
const worktreeToggle = document.querySelector("#worktreeToggle");
const branchValue = document.querySelector("#branchValue");
const groupValue = document.querySelector("#groupValue");
const advancedTrigger = document.querySelector("#advancedTrigger");
const advancedContent = document.querySelector("#advancedContent");
const launchMode = document.querySelector("#launchMode");
const createLabel = document.querySelector("#createLabel");
const createButton = document.querySelector("#createButton");
const toast = document.querySelector("#toast");
const fileInput = document.querySelector("#fileInput");
const attachmentList = document.querySelector("#attachmentList");
const footerAttachmentCount = document.querySelector("#footerAttachmentCount");
const summaryText = document.querySelector("#summaryText");

let currentMode = "single";
let currentWorkflow = "free";
let usesWorktree = true;

const modeCopy = {
  single: {
    label: "单任务",
    caption: "告诉执行者目标、交付物，以及什么算完成。",
    placeholder: "描述要做什么…（可输入 /team 或 /duet）",
    workflowTitle: "工作方式",
    workflowCaption: "自由模式按需派审和预览，完成后统一验收。",
    agent: "claude",
    profile: "claude@ccb",
    model: "claude-opus-5",
  },
  team: {
    label: "团队",
    caption: "给调度者清楚的目标、边界和最终交付物。",
    placeholder: "给调度者的目标…（可输入 /single 或 /duet）",
    workflowTitle: "执行模式",
    workflowCaption: "按团队预设分配调度、执行和审查角色。",
    agent: "codex",
    profile: "team lead",
    model: "gpt-5.6-codex",
  },
  duet: {
    label: "讨论",
    caption: "写下需要两种视角讨论并形成结论的议题。",
    placeholder: "要讨论并形成结论的议题…",
    workflowTitle: "讨论配置",
    workflowCaption: "两位讨论者独立思考，互相补强后形成共同方案。",
    agent: "claude × codex",
    profile: "双执行器",
    model: "最多 5 轮",
  },
};

function updateSummary() {
  const workflow = currentWorkflow === "free" ? "自由工作流" : "起手式";
  const location = usesWorktree ? "独立 worktree" : "项目目录";
  summaryText.textContent = `${modeCopy[currentMode].label} · ${workflow} · ${location}`;
}

function updatePromptState() {
  charCount.textContent = String(taskPrompt.value.length);
}

taskPrompt.addEventListener("input", updatePromptState);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentMode = button.dataset.mode;
    const copy = modeCopy[currentMode];
    modeButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    taskPrompt.placeholder = copy.placeholder;
    document.querySelector("#objectiveCaption").textContent = copy.caption;
    document.querySelector("#workflowTitle").textContent = copy.workflowTitle;
    document.querySelector("#workflowCaption").textContent = copy.workflowCaption;
    document.querySelector("#agentName").textContent = copy.agent;
    document.querySelector("#agentProfile").textContent = copy.profile;
    document.querySelector("#modelName").textContent = copy.model;
    updateSummary();
  });
});

workflowButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentWorkflow = button.dataset.workflow;
    workflowButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    const preset = currentWorkflow === "preset";
    executorBlock.hidden = preset;
    presetRoute.hidden = !preset;
    updateSummary();
  });
});

document.querySelectorAll("[data-suggestion]").forEach((button) => {
  button.addEventListener("click", () => {
    taskPrompt.value += `${taskPrompt.value.trim() ? "\n\n" : ""}${button.dataset.suggestion}`;
    updatePromptState();
    taskPrompt.focus();
  });
});

worktreeToggle.addEventListener("click", () => {
  usesWorktree = !usesWorktree;
  worktreeToggle.setAttribute("aria-checked", String(usesWorktree));
  worktreeToggle.querySelector(".ui-toggle").classList.toggle("is-on", usesWorktree);
  branchValue.textContent = usesWorktree ? "main" : "项目当前目录";
  updateSummary();
});

const branchOptions = ["main", "develop", "release/next"];
let branchIndex = 0;
document.querySelector("#branchButton").addEventListener("click", () => {
  if (!usesWorktree) return;
  branchIndex = (branchIndex + 1) % branchOptions.length;
  branchValue.textContent = branchOptions[branchIndex];
});

const groupOptions = ["无分组", "界面体验", "九月版本"];
let groupIndex = 0;
document.querySelector("#groupButton").addEventListener("click", () => {
  groupIndex = (groupIndex + 1) % groupOptions.length;
  groupValue.textContent = groupOptions[groupIndex];
});

advancedTrigger.addEventListener("click", () => {
  const expanded = advancedTrigger.getAttribute("aria-expanded") !== "true";
  advancedTrigger.setAttribute("aria-expanded", String(expanded));
  advancedContent.hidden = !expanded;
});

const launchLabels = { run: "创建并运行", create: "创建任务", schedule: "创建并定时" };
launchMode.addEventListener("change", () => { createLabel.textContent = launchLabels[launchMode.value]; });

function showToast() {
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

createButton.addEventListener("click", showToast);
toast.querySelector("button").addEventListener("click", () => toast.classList.remove("is-visible"));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    showToast();
  }
});

document.querySelectorAll("#attachButton, .composer-footer .task-reply-icon").forEach((button) => {
  button.addEventListener("click", () => fileInput.click());
});

function updateAttachmentCount() {
  footerAttachmentCount.textContent = String(attachmentList.children.length);
}

fileInput.addEventListener("change", () => {
  [...fileInput.files].forEach((file) => {
    const chip = document.createElement("span");
    const name = document.createElement("span");
    const remove = document.createElement("button");
    chip.className = "file-chip";
    name.textContent = file.name;
    remove.type = "button";
    remove.setAttribute("aria-label", `移除 ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => { chip.remove(); updateAttachmentCount(); });
    chip.append(name, remove);
    attachmentList.append(chip);
  });
  fileInput.value = "";
  updateAttachmentCount();
});

updatePromptState();
updateSummary();
