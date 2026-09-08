const query = (selector) => document.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const state = {
  mode: 'single', workflow: 'free', worktree: true, branch: 'main', group: '无分组', tags: '',
  roles: {
    worker: { agent: 'Claude', model: '跟随执行器', effort: '跟随' },
    lead: { agent: 'Claude', model: '跟随执行器', effort: '跟随' },
    teammate: { agent: 'Codex', model: '跟随执行器', effort: '跟随' },
    reviewer: { agent: 'Codex', model: '跟随执行器', effort: '跟随' },
    voiceA: { agent: 'Claude', model: '跟随执行器', effort: '跟随' },
    voiceB: { agent: 'Codex', model: '跟随执行器', effort: '跟随' },
  },
};
const modes = {
  single: { label: '单任务', hint: '一个执行者，专注完成', roles: [['worker', '执行者']] },
  team: { label: '团队', hint: '分工协作，由调度者推进', roles: [['lead', '调度者'], ['teammate', '执行者'], ['reviewer', '审查者']] },
  duet: { label: '讨论', hint: '两种视角，形成共同结论', roles: [['voiceA', '讨论者 A'], ['voiceB', '讨论者 B']] },
};
const starters = {
  bug: '请帮我定位并修复这个问题。\n\n现象：\n复现步骤：\n期望结果：\n\n完成后，请运行相关检查并说明根因。',
  feature: '我想增加一个新功能。\n\n使用场景：\n需要实现：\n不在本次范围：\n\n验收标准：',
  compare: '请比较下面的方案，并形成一个可执行的结论。\n\n背景：\n候选方案：\n主要顾虑：\n\n请说明各自的收益、成本和推荐理由。',
};
let openPanel = null;
let attachments = [];
let lastTrigger = null;
const storageKey = 'ash-task-studio-draft-v1';
query('#objective').placeholder = '想完成什么？\n\n可以描述一个问题，也可以交代一个完整目标。';

function renderRoles() {
  query('#roles').replaceChildren();
  modes[state.mode].roles.forEach(([key, label]) => {
    const row = document.createElement('div');
    row.className = 'role-row';
    const name = document.createElement('span');
    name.className = 'role-name';
    name.textContent = label;
    const picker = document.createElement('div');
    picker.className = 'target-picker';
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', label);
    const options = {
      agent: ['Claude', 'Codex'],
      model: ['跟随执行器'],
      effort: ['跟随', '低', '中', '高'],
    };
    Object.entries(options).forEach(([field, values]) => {
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${label}${{ agent: '智能体', model: '模型', effort: '智能水平' }[field]}`);
      values.forEach((value) => select.add(new Option(value, value)));
      select.value = state.roles[key][field];
      select.addEventListener('change', () => {
        state.roles[key][field] = select.value;
        if (field === 'agent') {
          state.roles[key].model = '跟随执行器';
          state.roles[key].effort = '跟随';
          renderRoles();
        }
        renderSummary();
      });
      picker.append(select);
    });
    row.append(name, picker);
    query('#roles').append(row);
  });
}

function renderSummary() {
  const isSingle = state.mode === 'single';
  const isTeam = state.mode === 'team';
  const people = isSingle ? state.roles.worker.agent : isTeam ? `${state.roles.lead.agent} 调度` : `${state.roles.voiceA.agent} × ${state.roles.voiceB.agent}`;
  query('#peopleSummary').textContent = people;
  query('#peopleDetail').textContent = isSingle ? `${state.roles.worker.model} · ${state.roles.worker.effort}` : isTeam ? `${state.roles.teammate.agent} 执行 · ${state.roles.reviewer.agent} 审查` : '独立思考，共同结论';
  query('#spaceSummary').textContent = state.worktree ? '独立 worktree' : '项目目录';
  query('#spaceDetail').textContent = state.worktree ? `基于 ${state.branch} · 互不干扰` : '直接在当前检出中执行';
  query('#branch').disabled = !state.worktree;
  query('#flowSummary').textContent = isSingle ? (state.workflow === 'free' ? '自由工作流' : '起手式') : isTeam ? '团队审查' : '共同结论';
  query('#flowDetail').textContent = isSingle ? '完成后，由你验收' : isTeam ? '执行者完成后派审' : '讨论结束后汇总结论';
  query('[data-panel="flow"]').disabled = !isSingle;
  query('#organizationSummary').textContent = `${state.group} · ${state.tags.trim() || '无标签'}`;
  query('#flowNote').textContent = state.workflow === 'free' ? '不会自动派审或合并，由你决定下一步。' : '演示线路：执行 → 审查 → 等待验收。实际接入时使用项目已有起手式。';
  query('#attach').disabled = state.mode === 'duet';
  query('#attachmentHint').textContent = state.mode === 'duet' ? '讨论不接收附件；已选文件保留，切回后可用' : '图片、文档或参考文件';
  query('#files').hidden = state.mode === 'duet';
  updateBody();
}

function setPanel(panel, restoreFocus = false) {
  openPanel = panel;
  all('[data-panel]').forEach((button) => button.setAttribute('aria-expanded', String(button.dataset.panel === panel)));
  all('.settings-panel').forEach((element) => { element.hidden = element.id !== `${panel}Panel`; });
  if (restoreFocus && lastTrigger) lastTrigger.focus();
}

function setMode(mode) {
  state.mode = mode;
  all('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  query('#modeHint').textContent = modes[mode].hint;
  if (openPanel === 'flow' && mode !== 'single') setPanel(null);
  renderRoles();
  renderSummary();
}

function updateBody() {
  query('#charCount').textContent = query('#objective').value.length;
  query('#submit').disabled = !query('#objective').value.trim();
  query('#result').hidden = true;
}

all('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
all('[data-panel]').forEach((button) => button.addEventListener('click', () => {
  lastTrigger = button;
  setPanel(openPanel === button.dataset.panel ? null : button.dataset.panel);
}));
all('.close-panel').forEach((button) => button.addEventListener('click', () => setPanel(null, true)));
query('#objective').addEventListener('input', updateBody);
query('#worktree').addEventListener('change', (event) => { state.worktree = event.target.checked; renderSummary(); });
['branch', 'group', 'tags'].forEach((id) => query(`#${id}`).addEventListener('input', (event) => { state[id] = event.target.value; renderSummary(); }));
all('[name="workflow"]').forEach((input) => input.addEventListener('change', () => { state.workflow = input.value; renderSummary(); }));
query('#launch').addEventListener('change', () => { query('#submit span').textContent = query('#launch').value === 'run' ? '创建并运行' : '创建任务'; updateBody(); });
all('[data-starter]').forEach((button) => button.addEventListener('click', () => {
  const template = starters[button.dataset.starter];
  query('#objective').value = `${query('#objective').value}${query('#objective').value.trim() ? '\n\n' : ''}${template}`.slice(0, 12000);
  if (button.dataset.starter === 'compare') setMode('duet');
  updateBody();
  query('#objective').focus();
}));

function renderFiles() {
  query('#files').replaceChildren();
  attachments.forEach((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'file';
    const label = document.createElement('span');
    label.textContent = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${file.name}`);
    remove.addEventListener('click', () => { attachments.splice(index, 1); renderFiles(); updateBody(); });
    chip.append(label, remove);
    query('#files').append(chip);
  });
}
query('#attach').addEventListener('click', () => query('#fileInput').click());
query('#fileInput').addEventListener('change', (event) => {
  attachments.push(...event.target.files);
  event.target.value = '';
  renderFiles();
  updateBody();
});

query('#saveDraft').addEventListener('click', () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ body: query('#objective').value, state, launch: query('#launch').value }));
    query('#draftStatus').textContent = '草稿已保存到本机浏览器（不含附件）';
  } catch { query('#draftStatus').textContent = '浏览器未允许保存草稿，正文仍在当前页。'; }
});
query('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!query('#objective').value.trim()) return;
  query('#resultText').textContent = `${query('#objective').value.trim().slice(0, 100)} — ${modes[state.mode].label} / ${query('#peopleSummary').textContent} / ${query('#spaceSummary').textContent} / ${query('#flowSummary').textContent} / ${query('#launch').value === 'run' ? '立即运行' : '仅创建'}。`;
  query('#result').hidden = false;
  query('#result').scrollIntoView({ block: 'nearest' });
});
query('#return').addEventListener('click', () => { query('#result').hidden = true; query('#objective').focus(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openPanel) setPanel(null, true);
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (query('#objective').value.trim()) query('#composer').requestSubmit();
  }
});

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && modes[saved.state?.mode] && typeof saved.body === 'string') {
    query('#objective').value = saved.body;
    state.mode = saved.state.mode;
    state.workflow = saved.state.workflow === 'preset' ? 'preset' : 'free';
    state.worktree = saved.state.worktree !== false;
    ['branch', 'group', 'tags'].forEach((key) => {
      if (typeof saved.state[key] === 'string') { query(`#${key}`).value = saved.state[key]; state[key] = query(`#${key}`).value; }
    });
    Object.keys(state.roles).forEach((key) => {
      const role = saved.state.roles?.[key];
      if (role && ['Claude', 'Codex'].includes(role.agent)) {
        state.roles[key].agent = role.agent;
        if (['跟随', '低', '中', '高'].includes(role.effort)) state.roles[key].effort = role.effort;
      }
    });
    query('#worktree').checked = state.worktree;
    query(`[name="workflow"][value="${state.workflow}"]`).checked = true;
    query('#launch').value = saved.launch === 'save' ? 'save' : 'run';
    query('#submit span').textContent = saved.launch === 'save' ? '创建任务' : '创建并运行';
    query('#draftStatus').textContent = '已恢复本机草稿（附件需重新添加）';
  }
} catch { query('#draftStatus').textContent = '本机草稿不可用；当前编辑不受影响'; }
setMode(state.mode);
