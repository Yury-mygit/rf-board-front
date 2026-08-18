// BRD-30 Stage 7-8: Layer panel — collapsible tree со списком элементов
// доски, drag-drop reorder через backend op="between".
//
// Модуль подгружается динамически при первом open() чтобы не пухнуть
// main bundle. Public API:
//   openLayerPanel({ getElements, onSelectId, apiZOrder, i18n, onClose })
//   refresh()
//   closeLayerPanel()
//   isOpen()
// getElements: () => Array<{id, type, parentId, attrs, z_rank, ...}>
// onSelectId: (id) => void  — синхронизация selection с канвасом
// apiZOrder: (targetId, body) => Promise  — обёртка над POST /z-order

import { t } from './i18n.js';

let _state = null;

const TYPE_ICONS = {
  frame: '▢',
  rect: '▭',
  oval: '⬭',
  line: '⁄',
  text: 'T',
  note: '✎',
  image: '🖼',
  bpmn_task: '◇',
  c4_person: '☺',
  c4_system: '⚙',
};

function iconFor(type) {
  return TYPE_ICONS[type] || '•';
}

function nameFor(el) {
  const text = (el.attrs && el.attrs.text) || '';
  if (text.trim()) return text.trim().slice(0, 40);
  return el.type;
}

function rankTail(z_rank) {
  if (!z_rank) return '';
  return z_rank.length > 6 ? '…' + z_rank.slice(-6) : z_rank;
}

// Строит tree: {node, children[]} рекурсивно. Top-level — parentId=null,
// сортировка внутри каждого уровня — по z_rank ASC.
function buildTree(elements) {
  const byParent = new Map();
  for (const el of elements) {
    const key = el.parentId || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(el);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => (a.z_rank || '').localeCompare(b.z_rank || ''));
  }
  function rec(parentId) {
    const items = byParent.get(parentId) || [];
    return items.map(el => ({ node: el, children: rec(el.id) }));
  }
  return rec(null);
}

// Flatten tree в linear array с depth для render (учитывая collapsed).
function flatten(tree, depth, collapsed, out) {
  for (const { node, children } of tree) {
    out.push({ node, depth });
    if (children.length && !collapsed.has(node.id)) {
      flatten(children, depth + 1, collapsed, out);
    }
  }
  return out;
}

function renderRow({ node, depth }, { selectedIds, collapsed, hasChildren }) {
  const row = document.createElement('div');
  row.className = 'lp-row depth-' + Math.min(depth, 4);
  row.dataset.id = node.id;
  row.draggable = true;
  if (selectedIds && selectedIds.has(node.id)) row.classList.add('selected');

  const expander = document.createElement('span');
  expander.className = 'lp-row-expander';
  if (hasChildren) {
    expander.textContent = collapsed.has(node.id) ? '▸' : '▾';
    expander.style.cursor = 'pointer';
    expander.dataset.expander = '1';
  } else {
    expander.textContent = '';
  }
  row.appendChild(expander);

  const icon = document.createElement('span');
  icon.className = 'lp-row-icon';
  icon.textContent = iconFor(node.type);
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'lp-row-name';
  name.textContent = nameFor(node);
  row.appendChild(name);

  const rank = document.createElement('span');
  rank.className = 'lp-row-rank';
  rank.textContent = rankTail(node.z_rank);
  row.appendChild(rank);

  return row;
}

function render() {
  if (!_state) return;
  const { body, getElements, collapsed, selectedIds } = _state;
  body.textContent = '';
  const elements = getElements();
  if (!elements || !elements.length) {
    const empty = document.createElement('div');
    empty.className = 'lp-empty';
    empty.textContent = t('layers.empty');
    body.appendChild(empty);
    return;
  }
  const tree = buildTree(elements);
  const flat = flatten(tree, 0, collapsed, []);
  // Precompute hasChildren.
  const byId = new Map(elements.map(e => [e.id, e]));
  const childrenById = new Map();
  for (const e of elements) {
    const pid = e.parentId || null;
    if (pid) {
      if (!childrenById.has(pid)) childrenById.set(pid, 0);
      childrenById.set(pid, childrenById.get(pid) + 1);
    }
  }
  for (const item of flat) {
    const hasChildren = (childrenById.get(item.node.id) || 0) > 0;
    const row = renderRow(item, { selectedIds, collapsed, hasChildren });
    body.appendChild(row);
  }
}

// ── Event handlers on body (event delegation) ────────────────────────

function attachHandlers() {
  const { body, onSelectId, apiZOrder, getElements, collapsed } = _state;

  body.addEventListener('click', (e) => {
    const expander = e.target.closest('[data-expander]');
    if (expander) {
      const row = expander.closest('.lp-row');
      const id = row && row.dataset.id;
      if (id) {
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        render();
      }
      return;
    }
    const row = e.target.closest('.lp-row');
    if (row && row.dataset.id) {
      onSelectId && onSelectId(row.dataset.id);
    }
  });

  let dragSrc = null;

  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.lp-row');
    if (!row) return;
    dragSrc = row.dataset.id;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrc);
    }
  });

  body.addEventListener('dragend', (e) => {
    body.querySelectorAll('.lp-row.dragging').forEach(r => r.classList.remove('dragging'));
    body.querySelectorAll('.lp-drop-line').forEach(el => el.remove());
    dragSrc = null;
  });

  body.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.lp-row');
    body.querySelectorAll('.lp-drop-line').forEach(el => el.remove());
    if (!row || row.dataset.id === dragSrc) return;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const line = document.createElement('div');
    line.className = 'lp-drop-line';
    if (e.clientY < midY) {
      row.parentNode.insertBefore(line, row);
    } else {
      row.parentNode.insertBefore(line, row.nextSibling);
    }
  });

  body.addEventListener('drop', async (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    const row = e.target.closest('.lp-row');
    body.querySelectorAll('.lp-drop-line').forEach(el => el.remove());
    if (!row || row.dataset.id === dragSrc) return;
    const targetId = dragSrc;
    const rect = row.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const above = e.clientY < midY;
    // Drop-line попадает между двумя row'ами. Собираем оба соседа —
    // upperRow (в UI выше drop-line = min z_rank; backend afterId),
    // lowerRow (в UI ниже = max z_rank; backend beforeId).
    // Sort ASC значит top of list = lowest z_rank = визуально сзади.
    // Исключаем сам target из соседей (иначе round-trip).
    const allRows = Array.from(body.querySelectorAll('.lp-row'))
      .filter(r => r.dataset.id !== targetId);
    const idx = allRows.indexOf(row);
    let upperRowId = null;
    let lowerRowId = null;
    if (above) {
      // Drop-line над row → между (allRows[idx-1]) и row.
      upperRowId = idx > 0 ? allRows[idx - 1].dataset.id : null;
      lowerRowId = row.dataset.id;
    } else {
      // Drop-line под row → между row и (allRows[idx+1]).
      upperRowId = row.dataset.id;
      lowerRowId = idx < allRows.length - 1 ? allRows[idx + 1].dataset.id : null;
    }
    const body_ = { op: 'between', cascadeFrame: true };
    if (upperRowId) body_.afterId = upperRowId;
    if (lowerRowId) body_.beforeId = lowerRowId;
    try {
      await apiZOrder(targetId, body_);
      // SSE echo сделает refresh автоматически.
    } catch (err) {
      console.error('layer-panel: drop failed', err);
    }
  });
}

// ── Public API ───────────────────────────────────────────────────────

export function openLayerPanel(opts) {
  const panel = document.getElementById('layers-panel');
  const body = document.getElementById('lp-body');
  const closeBtn = document.getElementById('lp-close');
  if (!panel || !body) {
    console.error('layer-panel: DOM elements not found');
    return;
  }
  _state = {
    panel, body, closeBtn,
    getElements: opts.getElements,
    onSelectId: opts.onSelectId,
    apiZOrder: opts.apiZOrder,
    onClose: opts.onClose,
    collapsed: new Set(),
    selectedIds: opts.selectedIds || new Set(),
  };
  panel.hidden = false;
  attachHandlers();
  if (closeBtn) {
    closeBtn.onclick = () => closeLayerPanel();
  }
  render();
}

export function closeLayerPanel() {
  if (!_state) return;
  _state.panel.hidden = true;
  const cb = _state.onClose;
  _state = null;
  if (cb) cb();
}

export function isOpen() {
  return _state !== null;
}

export function refresh(selectedIds) {
  if (!_state) return;
  if (selectedIds) _state.selectedIds = selectedIds;
  render();
}
