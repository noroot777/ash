const taskPrompt = document.querySelector("#taskPrompt");
const charCount = document.querySelector("#charCount");
const promptWrap = document.querySelector(".prompt-wrap");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const workflowButtons = [...document.querySelectorAll(".workflow-tabs button")];
const executorCard = document.querySelector("#executorCard");
const workflowRoute = document.querySelector("#workflowRoute");
const workflowCaption = document.querySelector("#workflowCaption");
const worktreeToggle = document.querySelector("#worktreeToggle");
const branchValue = document.querySelector("#branchValue");
const advancedTrigger = document.querySelector("#advancedTrigger");
const advancedContent = document.querySelector("#advancedContent");
const launchMode = document.querySelector("#launchMode");
const createLabel = document.querySelector("#createLabel");
const createButton = document.querySelector("#createButton");
const toast = document.querySelector("#toast");
const fileInput = document.querySelector("#fileInput");
const attachmentList = document.querySelector("#attachmentList");

const modeCopy = {
  single: {
    title: "单任务",
    placeholder: "描述目标、交付物和判断完成的标准…\n\n也可以输入 /team、/duet 或技能命令。",
    agent: "claude",
    avatar: "C",
    model: "opus-5 · 跟随",
    hintTitle: "从一个清楚的结果开始",
    hintBody: "例如：重做新建任务页，让信息层级更清楚，并给出可验证的 HTML demo。",
  },
  team: {
    title: "团队任务",
    placeholder: "给调度者一个清楚的目标、边界和最终交付物…\n\n团队会自行拆解，并行推进后汇总。",
    agent: "codex lead + 3 workers",
    avatar: "T",
    model: "团队预设 · 默认",
    hintTitle: "告诉调度者终点在哪里",
    hintBody: "写清交付物和边界，拆解与协作方式交给团队决定。",
  },
  duet: {
    title: "讨论",
    placeholder: "写下需要两种视角充分讨论，并最终形成共同结论的议题…",
    agent: "claude × codex",
    avatar: "D",
    model: "最多 5 轮",
    hintTitle: "先写下真正的分歧",
    hintBody: "说明需要比较的观点，以及最终希望形成哪种共同结论。",
  },
};

function updatePromptState() {
  const length = taskPrompt.value.length;
  charCount.textContent = String(length);
  promptWrap.classList.toggle("has-copy", length > 0);
}

taskPrompt.addEventListener("input", updatePromptState);

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    const copy = modeCopy[mode];
    modeButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    taskPrompt.placeholder = copy.placeholder;
    executorCard.querySelector(".agent-avatar").textContent = copy.avatar;
    executorCard.querySelector("b").textContent = copy.agent;
    executorCard.querySelector(".model-name").textContent = copy.model;
    document.querySelector("#promptHint b").textContent = copy.hintTitle;
    document.querySelector("#promptHint span").textContent = copy.hintBody;
  });
});

workflowButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.workflow === "preset";
    workflowButtons.forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-checked", String(active));
    });
    executorCard.hidden = preset;
    workflowRoute.hidden = !preset;
    workflowCaption.textContent = preset
      ? "按标准线路自动推进：理解、实现、验证、交付。"
      : "按需派审和预览，完成后由你统一验收。";
  });
});

document.querySelectorAll("[data-suggestion]").forEach((button) => {
  button.addEventListener("click", () => {
    const prefix = taskPrompt.value.trim() ? "\n\n" : "";
    taskPrompt.value += prefix + button.dataset.suggestion;
    updatePromptState();
    taskPrompt.focus();
  });
});

worktreeToggle.addEventListener("click", () => {
  const isOn = worktreeToggle.getAttribute("aria-checked") !== "true";
  worktreeToggle.setAttribute("aria-checked", String(isOn));
  worktreeToggle.classList.toggle("is-on", isOn);
  branchValue.textContent = isOn ? "main" : "项目当前目录";
});

const branchOptions = ["main", "develop", "release/next"];
let branchIndex = 0;
document.querySelector("#branchButton").addEventListener("click", () => {
  if (worktreeToggle.getAttribute("aria-checked") !== "true") return;
  branchIndex = (branchIndex + 1) % branchOptions.length;
  branchValue.textContent = branchOptions[branchIndex];
});

const groupOptions = ["无分组", "界面体验", "九月版本"];
let groupIndex = 0;
document.querySelector("#groupButton").addEventListener("click", () => {
  groupIndex = (groupIndex + 1) % groupOptions.length;
  document.querySelector("#groupValue").textContent = groupOptions[groupIndex];
});

advancedTrigger.addEventListener("click", () => {
  const expanded = advancedTrigger.getAttribute("aria-expanded") !== "true";
  advancedTrigger.setAttribute("aria-expanded", String(expanded));
  advancedContent.hidden = !expanded;
});

const launchLabels = {
  run: "创建并运行",
  create: "创建任务",
  schedule: "创建并定时",
};

launchMode.addEventListener("change", () => {
  createLabel.textContent = launchLabels[launchMode.value];
});

function showToast() {
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 4200);
}

createButton.addEventListener("click", showToast);
toast.querySelector("button").addEventListener("click", () => toast.classList.remove("is-visible"));

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    showToast();
  }
});

document.querySelector("#attachButton").addEventListener("click", () => fileInput.click());
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
    remove.addEventListener("click", () => chip.remove());
    chip.append(name, remove);
    attachmentList.append(chip);
  });
  fileInput.value = "";
});

updatePromptState();
