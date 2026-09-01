const sceneButtons = [...document.querySelectorAll('[data-scene]')];
const scenePanels = [...document.querySelectorAll('[data-panel]')];

function showScene(name) {
  sceneButtons.forEach((button) => {
    const active = button.dataset.scene === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  scenePanels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
}

sceneButtons.forEach((button) => {
  button.addEventListener('click', () => showScene(button.dataset.scene));
});

document.querySelectorAll('.choice').forEach((choice) => {
  choice.addEventListener('click', () => {
    document.querySelectorAll('.choice').forEach((item) => {
      const selected = item === choice;
      item.classList.toggle('selected', selected);
      item.querySelector('i').textContent = selected ? '✓' : '';
    });
  });
});

const resolveButton = document.querySelector('#resolveButton');
resolveButton.addEventListener('click', () => {
  const card = document.querySelector('#conflictCard');
  card.classList.add('resolved');
  document.querySelector('#conflictEyebrow').textContent = '已准备好';
  document.querySelector('#conflictTitle').textContent = '冲突已解决，可以重新验收';
  document.querySelector('#conflictSummary').innerHTML = '任务分支已完成自检。<span class="safe-pill">✓ main 仍未改变</span>';
  document.querySelector('#conflictNode').textContent = '✓';
  document.querySelector('#fileState').textContent = '已解决';
  resolveButton.textContent = '重新验收';
});

showScene('overview');
