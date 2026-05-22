import { initBoard, setBoardCursor, loadBoard, clearBoard, applyElementAttrs, deselect as boardDeselect, removeElements as boardRemoveElements, exitEdit as boardExitEdit, getAllSelected as boardGetAllSelected, getSelectedCount as boardGetSelectedCount, addFromApi as boardAddFromApi, setElementGeo as boardSetElementGeo, setElementParent as boardSetElementParent, getElementById as boardGetElementById, zoomIn as boardZoomIn, zoomOut as boardZoomOut, fitView as boardFitView, setViewport as boardSetViewport, worldToScreen as boardWorldToScreen, isEditing as boardIsEditing } from './board.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// crypto.randomUUID() requires a secure context (HTTPS) — fall back to v4 via getRandomValues.
function randomUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ── API ───────────────────────────────────────────────────────────────────────

const BASE = '/api/v1';

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(body || res.statusText), { status: res.status });
  }
  return res;
}

const api = {
  boards: () => apiFetch('/boards').then(r => r.json()),
  createBoard: body =>
    apiFetch('/boards', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  board: id => apiFetch(`/boards/${id}`).then(r => r.json()),
  patchBoard: (id, data) =>
    apiFetch(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify(data) }).then(r => r.json()),
  deleteBoard: id =>
    apiFetch(`/boards/${id}`, { method: 'DELETE' }),
  createElement: (boardId, body) =>
    apiFetch(`/boards/${boardId}/elements`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()),
  patchElement: (boardId, elementId, data) =>
    apiFetch(`/boards/${boardId}/elements/${elementId}`, { method: 'PATCH', body: JSON.stringify(data) }).then(r => r.json()),
  deleteElement: (boardId, elementId) =>
    apiFetch(`/boards/${boardId}/elements/${elementId}`, { method: 'DELETE' }),
  restoreElement: (boardId, elementId) =>
    apiFetch(`/boards/${boardId}/elements/${elementId}/restore`, { method: 'POST' }).then(r => r.json()),
};

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'err' : 'ok';
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
}

// ── Board state ───────────────────────────────────────────────────────────────

let boardTool = null;
let allBoards = [];
let currentBoardId = null;
const elementSaveTimers = new Map(); // id → timeoutId (debounced PATCH)

function setBoardTool(name) {
  boardTool = boardTool === name ? null : name;
  document.querySelectorAll('.board-tool').forEach(el => {
    el.classList.toggle('active', el.dataset.tool === boardTool);
  });
  setBoardCursor(boardTool);
}

function clearBoardTool() {
  boardTool = null;
  document.querySelectorAll('.board-tool').forEach(el => el.classList.remove('active'));
  setBoardCursor(null);
}

function recToApiGeometry(rec) {
  if (rec.type === 'line') {
    return {
      x: rec.x1, y: rec.y1,
      w: rec.x2 - rec.x1, h: rec.y2 - rec.y1,
      attrs: rec.attrs || {},
    };
  }
  return { x: rec.x, y: rec.y, w: rec.w, h: rec.h, attrs: rec.attrs || {} };
}

async function saveElementCreate(rec) {
  if (!currentBoardId) return;
  const now = Date.now();
  const body = {
    id: rec.id, type: rec.type, parentId: rec.parentId || null,
    ...recToApiGeometry(rec),
    createdAt: now, updatedAt: now,
  };
  try {
    await api.createElement(currentBoardId, body);
    pushUndo({ kind: 'create', records: [snapshotRec(rec)] });
  } catch (e) {
    setStatus(`Ошибка создания элемента: ${e.message}`, true);
  }
}

// ── Context-menu (Miro-style fill/stroke palette) ─────────────────────────────

const PALETTE = [
  null,        '#ffffff',   '#dee2e6',   '#212529',
  '#fff3bf',   '#ffd43b',   '#fab005',   '#fd7e14',
  '#ffd8a8',   '#ff8787',   '#fa5252',   '#e03131',
  '#d3f9d8',   '#69db7c',   '#37b24d',   '#2b8a3e',
  '#a5d8ff',   '#4dabf7',   '#1971c2',   '#0c4d8e',
  '#e599f7',   '#cc5de8',   '#7950f2',   '#5f3dc4',
];
const LIGHT_COLORS = new Set(['#ffffff','#dee2e6','#fff3bf','#ffd43b','#ffd8a8','#ff8787','#d3f9d8','#69db7c','#a5d8ff','#4dabf7','#e599f7']);

const DEFAULT_FILL = '#ffffff';
const DEFAULT_STROKE = '#212529';
const DEFAULT_COLOR = '#212529';
const DEFAULT_FONT_SIZE = 14;

let ctxMenuTarget = null;
let ctxPaletteFor = null;

function buildContextMenu() {
  const fillBtn = document.getElementById('ctx-fill-btn');
  const strokeBtn = document.getElementById('ctx-stroke-btn');
  const colorBtn = document.getElementById('ctx-color-btn');
  const boldBtn = document.getElementById('ctx-bold-btn');
  const italicBtn = document.getElementById('ctx-italic-btn');
  const underlineBtn = document.getElementById('ctx-underline-btn');
  const sizeSelect = document.getElementById('ctx-size');
  const grid = document.getElementById('ctx-grid');
  const opacity = document.getElementById('ctx-opacity');
  const opacityVal = document.getElementById('ctx-opacity-val');

  grid.innerHTML = PALETTE.map((c, i) => {
    if (c === null) return `<button class="ctx-color no-color" data-i="${i}" title="Без цвета"></button>`;
    const light = LIGHT_COLORS.has(c) ? ' light' : '';
    return `<button class="ctx-color${light}" data-i="${i}" style="background-color:${c}" title="${c}"></button>`;
  }).join('');

  document.getElementById('board-context-menu').addEventListener('mousedown', e => e.stopPropagation());

  fillBtn.addEventListener('click', e => { e.stopPropagation(); togglePalette('fill'); });
  strokeBtn.addEventListener('click', e => { e.stopPropagation(); togglePalette('stroke'); });
  colorBtn.addEventListener('click', e => { e.stopPropagation(); togglePalette('color'); });

  const toggleAttr = (prop) => {
    if (!ctxMenuTarget) return;
    const before = ctxMenuTarget.attrs?.[prop];
    const after = !before;
    commitAttrChange(ctxMenuTarget, { [prop]: before }, { [prop]: after });
    refreshContextUI();
  };
  boldBtn.addEventListener('click', e => { e.stopPropagation(); toggleAttr('bold'); });
  italicBtn.addEventListener('click', e => { e.stopPropagation(); toggleAttr('italic'); });
  underlineBtn.addEventListener('click', e => { e.stopPropagation(); toggleAttr('underline'); });

  sizeSelect.addEventListener('change', e => {
    e.stopPropagation();
    if (!ctxMenuTarget) return;
    const before = ctxMenuTarget.attrs?.fontSize;
    const after = +sizeSelect.value;
    if (before === after) return;
    commitAttrChange(ctxMenuTarget, { fontSize: before }, { fontSize: after });
  });

  grid.querySelectorAll('.ctx-color').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (!ctxMenuTarget || !ctxPaletteFor) return;
      const i = +b.dataset.i;
      const c = PALETTE[i];
      const before = ctxMenuTarget.attrs?.[ctxPaletteFor];
      if (before === c) return;
      commitAttrChange(ctxMenuTarget, { [ctxPaletteFor]: before }, { [ctxPaletteFor]: c });
      refreshContextUI();
    });
  });

  let opacityBefore = undefined;
  opacity.addEventListener('mousedown', () => {
    if (!ctxMenuTarget || !ctxPaletteFor || ctxPaletteFor === 'color') return;
    opacityBefore = ctxMenuTarget.attrs?.[ctxPaletteFor + 'Opacity'];
  });
  opacity.addEventListener('input', () => {
    opacityVal.textContent = opacity.value + '%';
    if (!ctxMenuTarget || !ctxPaletteFor || ctxPaletteFor === 'color') return;
    const v = +opacity.value / 100;
    ctxMenuTarget.attrs = ctxMenuTarget.attrs || {};
    ctxMenuTarget.attrs[ctxPaletteFor + 'Opacity'] = v;
    applyElementAttrs(ctxMenuTarget);
    refreshContextUI();
  });
  opacity.addEventListener('change', () => {
    if (!ctxMenuTarget || !ctxPaletteFor || ctxPaletteFor === 'color') return;
    const key = ctxPaletteFor + 'Opacity';
    const after = ctxMenuTarget.attrs[key];
    scheduleElementSave(ctxMenuTarget);
    if (opacityBefore !== after) {
      pushUndo({ kind: 'attrs', id: ctxMenuTarget.id,
        before: { [key]: opacityBefore },
        after: { [key]: after },
      });
    }
    opacityBefore = undefined;
  });

  document.addEventListener('mousedown', e => {
    const menu = document.getElementById('board-context-menu');
    if (ctxPaletteFor && menu && !menu.contains(e.target)) {
      closePalette();
    }
  });
}

function closePalette() {
  ctxPaletteFor = null;
  document.getElementById('ctx-palette').style.display = 'none';
  document.getElementById('ctx-fill-btn').classList.remove('active');
  document.getElementById('ctx-stroke-btn').classList.remove('active');
  document.getElementById('ctx-color-btn').classList.remove('active');
}

function togglePalette(prop) {
  const palette = document.getElementById('ctx-palette');
  if (ctxPaletteFor === prop) { closePalette(); return; }
  ctxPaletteFor = prop;
  palette.style.display = '';
  document.getElementById('ctx-fill-btn').classList.toggle('active', prop === 'fill');
  document.getElementById('ctx-stroke-btn').classList.toggle('active', prop === 'stroke');
  document.getElementById('ctx-color-btn').classList.toggle('active', prop === 'color');
  document.getElementById('ctx-opacity-row').style.display = (prop === 'color') ? 'none' : '';
  refreshContextUI();
}

function refreshContextUI() {
  if (!ctxMenuTarget) return;
  const a = ctxMenuTarget.attrs || {};
  if (ctxMenuTarget.type === 'rect') {
    const fill = a.fill !== undefined ? a.fill : DEFAULT_FILL;
    const stroke = a.stroke !== undefined ? a.stroke : DEFAULT_STROKE;
    const fillIcon = document.querySelector('.ctx-tool-fill');
    const strokeIcon = document.querySelector('.ctx-tool-stroke');
    if (fill === null) {
      fillIcon.classList.add('no-color');
      fillIcon.style.backgroundColor = '#fff';
    } else {
      fillIcon.classList.remove('no-color');
      fillIcon.style.backgroundColor = fill;
    }
    if (stroke === null) {
      strokeIcon.classList.add('no-color');
      strokeIcon.style.borderColor = '#adb5bd';
    } else {
      strokeIcon.classList.remove('no-color');
      strokeIcon.style.borderColor = stroke;
    }
  } else if (ctxMenuTarget.type === 'text') {
    const color = a.color !== undefined ? a.color : DEFAULT_COLOR;
    const colorBar = document.querySelector('.ctx-color-bar');
    if (colorBar) colorBar.style.background = color === null ? 'transparent' : color;
    document.getElementById('ctx-bold-btn').classList.toggle('active', !!a.bold);
    document.getElementById('ctx-italic-btn').classList.toggle('active', !!a.italic);
    document.getElementById('ctx-underline-btn').classList.toggle('active', !!a.underline);
    document.getElementById('ctx-size').value = a.fontSize || DEFAULT_FONT_SIZE;
  }
  if (ctxPaletteFor) {
    const current = a[ctxPaletteFor] !== undefined
      ? a[ctxPaletteFor]
      : (ctxPaletteFor === 'fill' ? DEFAULT_FILL : ctxPaletteFor === 'stroke' ? DEFAULT_STROKE : DEFAULT_COLOR);
    document.querySelectorAll('#ctx-grid .ctx-color').forEach(b => {
      const i = +b.dataset.i;
      b.classList.toggle('active', PALETTE[i] === current);
    });
    if (ctxPaletteFor !== 'color') {
      const op = a[ctxPaletteFor + 'Opacity'];
      const opVal = (op === undefined ? 1 : op) * 100;
      document.getElementById('ctx-opacity').value = Math.round(opVal);
      document.getElementById('ctx-opacity-val').textContent = Math.round(opVal) + '%';
    }
  }
}

function showContextMenu(rec, bbox) {
  const menu = document.getElementById('board-context-menu');
  const tbRect = document.getElementById('ctx-toolbar-rect');
  const tbText = document.getElementById('ctx-toolbar-text');
  if (!rec || (rec.type !== 'rect' && rec.type !== 'text')) {
    hideContextMenu();
    return;
  }
  if (ctxMenuTarget && ctxMenuTarget.type !== rec.type) closePalette();
  ctxMenuTarget = rec;
  menu.style.display = '';
  tbRect.style.display = rec.type === 'rect' ? '' : 'none';
  tbText.style.display = rec.type === 'text' ? '' : 'none';
  positionContextMenu(bbox);
  refreshContextUI();
}

function hideContextMenu() {
  const menu = document.getElementById('board-context-menu');
  const palette = document.getElementById('ctx-palette');
  ctxMenuTarget = null;
  ctxPaletteFor = null;
  if (palette) palette.style.display = 'none';
  document.getElementById('ctx-fill-btn')?.classList.remove('active');
  document.getElementById('ctx-stroke-btn')?.classList.remove('active');
  menu.style.display = 'none';
}

function positionContextMenu(bbox) {
  const menu = document.getElementById('board-context-menu');
  const content = document.querySelector('.board-content');
  if (!content) return;
  const cR = content.getBoundingClientRect();
  // bbox в world-координатах — конвертируем в screen для DOM-overlay.
  const tl = boardWorldToScreen(bbox.x, bbox.y);
  const bl = boardWorldToScreen(bbox.x, bbox.y + bbox.h);
  const padding = 8;
  const TOOLBAR_H = 46;
  let topClient = tl.y - TOOLBAR_H - padding;
  if (topClient - cR.top < 4) topClient = bl.y + padding;
  menu.style.left = (tl.x - cR.left) + 'px';
  menu.style.top  = (topClient - cR.top) + 'px';
}

let boardSelected = null;
let lastSelectedBbox = null;

function onBoardSelectionChanged(rec, bbox) {
  boardSelected = rec;
  lastSelectedBbox = bbox || null;
  if (!rec) hideContextMenu();
  else showContextMenu(rec, bbox);
}

// ── Board undo / redo ─────────────────────────────────────────────────────────

const UNDO_LIMIT = 50;
let undoStack = [];
let redoStack = [];

function clearUndo() {
  undoStack = [];
  redoStack = [];
}

function pushUndo(op) {
  undoStack.push(op);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

async function undoBoard() {
  const op = undoStack.pop();
  if (!op) return;
  try {
    await applyOp(op, 'inverse');
    redoStack.push(op);
  } catch (err) {
    setStatus(`Undo error: ${err.message}`, true);
  }
}

async function redoBoard() {
  const op = redoStack.pop();
  if (!op) return;
  try {
    await applyOp(op, 'forward');
    undoStack.push(op);
  } catch (err) {
    setStatus(`Redo error: ${err.message}`, true);
  }
}

async function applyOp(op, direction) {
  switch (op.kind) {
    case 'create': return applyCreate(op, direction);
    case 'delete': return applyDelete(op, direction);
    case 'move':   return applyMove(op, direction);
    case 'resize': return applyResize(op, direction);
    case 'attrs':  return applyAttrs(op, direction);
    default:       throw new Error(`Unknown op.kind: ${op.kind}`);
  }
}

function snapshotRec(rec) {
  if (rec.type === 'line') {
    return {
      id: rec.id, type: 'line',
      x: rec.x1, y: rec.y1,
      w: rec.x2 - rec.x1, h: rec.y2 - rec.y1,
      attrs: { ...(rec.attrs || {}) },
      parentId: rec.parentId || null,
    };
  }
  return {
    id: rec.id, type: rec.type,
    x: rec.x, y: rec.y, w: rec.w, h: rec.h,
    attrs: { ...(rec.attrs || {}) },
    parentId: rec.parentId || null,
  };
}

async function eraseElements(ids) {
  if (!currentBoardId || !ids.length) return;
  const boardId = currentBoardId;
  for (const id of ids) {
    const pending = elementSaveTimers.get(id);
    if (pending) { clearTimeout(pending); elementSaveTimers.delete(id); }
  }
  boardRemoveElements(ids);
  await Promise.all(ids.map(id => api.deleteElement(boardId, id)));
}

async function recreateElements(snapshots) {
  if (!currentBoardId || !snapshots.length) return;
  const boardId = currentBoardId;
  await Promise.all(snapshots.map(s => api.restoreElement(boardId, s.id)));
  for (const s of snapshots) boardAddFromApi(s);
}

async function applyCreate(op, direction) {
  if (direction === 'inverse') return eraseElements(op.records.map(r => r.id));
  return recreateElements(op.records);
}

async function applyDelete(op, direction) {
  if (direction === 'inverse') return recreateElements(op.records);
  return eraseElements(op.records.map(r => r.id));
}

async function applyMove(op, direction) {
  if (!currentBoardId) return;
  const boardId = currentBoardId;
  const target = direction === 'inverse' ? 'before' : 'after';
  for (const it of op.items) {
    const pending = elementSaveTimers.get(it.id);
    if (pending) { clearTimeout(pending); elementSaveTimers.delete(it.id); }
  }
  await Promise.all(op.items.map(async it => {
    const geo = it[target];
    boardSetElementGeo(it.id, geo);
    return api.patchElement(boardId, it.id, {
      x: geo.x, y: geo.y, w: geo.w, h: geo.h,
      parentId: geo.parentId || null,
      updatedAt: Date.now(),
    });
  }));
}

async function applyResize(op, direction) {
  if (!currentBoardId) return;
  const boardId = currentBoardId;
  const target = direction === 'inverse' ? 'before' : 'after';
  const ids = [op.id, ...op.childParents.map(c => c.id)];
  for (const id of ids) {
    const pending = elementSaveTimers.get(id);
    if (pending) { clearTimeout(pending); elementSaveTimers.delete(id); }
  }
  const geo = op[target];
  boardSetElementGeo(op.id, geo);
  const promises = [];
  promises.push(api.patchElement(boardId, op.id, {
    x: geo.x, y: geo.y, w: geo.w, h: geo.h,
    parentId: geo.parentId || null,
    updatedAt: Date.now(),
  }));
  for (const c of op.childParents) {
    const cParent = c[target];
    boardSetElementParent(c.id, cParent);
    promises.push(api.patchElement(boardId, c.id, {
      parentId: cParent || null,
      updatedAt: Date.now(),
    }));
  }
  await Promise.all(promises);
}

async function applyAttrs(op, direction) {
  if (!currentBoardId) return;
  const boardId = currentBoardId;
  const target = direction === 'inverse' ? 'before' : 'after';
  const rec = boardGetElementById(op.id);
  if (!rec) return;
  const pending = elementSaveTimers.get(op.id);
  if (pending) { clearTimeout(pending); elementSaveTimers.delete(op.id); }
  rec.attrs = rec.attrs || {};
  for (const [k, v] of Object.entries(op[target])) {
    if (v === undefined) delete rec.attrs[k];
    else rec.attrs[k] = v;
  }
  applyElementAttrs(rec);
  await api.patchElement(boardId, op.id, {
    attrs: { ...rec.attrs },
    updatedAt: Date.now(),
  });
}

function commitAttrChange(rec, before, after) {
  rec.attrs = rec.attrs || {};
  for (const [k, v] of Object.entries(after)) {
    if (v === undefined) delete rec.attrs[k];
    else rec.attrs[k] = v;
  }
  applyElementAttrs(rec);
  scheduleElementSave(rec);
  pushUndo({ kind: 'attrs', id: rec.id, before, after });
}

// ── Board keyboard (Esc / Del / Backspace / Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) ───

function onBoardKeydown(e) {
  const target = e.target;
  const isInputTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  // Явный edit-mode (двойной клик в text/note) — Delete и Ctrl+Z работают как
  // обычное редактирование. Иначе — операции относятся к доске, даже если
  // фокус случайно остался в каком-то input (например, в title фрейма).
  const inBoardEdit = boardIsEditing();

  const mod = e.ctrlKey || e.metaKey;
  if (mod && !inBoardEdit) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (isInputTarget) target.blur();
      undoBoard();
      return;
    }
    if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      if (isInputTarget) target.blur();
      redoBoard();
      return;
    }
  }

  if (e.key === 'Escape') {
    if (inBoardEdit) {
      boardExitEdit();
      e.preventDefault();
      return;
    }
    if (isInputTarget) {
      target.blur();
      e.preventDefault();
      return;
    }
    if (ctxPaletteFor) {
      closePalette();
      e.preventDefault();
      return;
    }
    if (boardSelected) {
      boardDeselect();
      e.preventDefault();
    }
    return;
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (inBoardEdit) return; // редактирование text/note — Delete печатает
    if (boardGetSelectedCount() === 0) return;
    e.preventDefault();
    if (isInputTarget) target.blur();
    deleteBoardSelected();
  }
}

async function deleteBoardSelected() {
  if (!currentBoardId) return;
  const all = boardGetAllSelected();
  if (!all.length) return;
  const snapshots = all.map(snapshotRec);
  try {
    await eraseElements(snapshots.map(s => s.id));
    pushUndo({ kind: 'delete', records: snapshots });
  } catch (err) {
    setStatus(`Ошибка удаления элемента: ${err.message}`, true);
  }
}

// ── Frame copy (HTML / картинка) ───────────────────────────────────────────────

let copyMenuTarget = null;

function openCopyMenu(rec, btn) {
  const menu = document.getElementById('frame-copy-menu');
  copyMenuTarget = rec;
  const btnR = btn.getBoundingClientRect();
  const contentR = document.querySelector('.board-content').getBoundingClientRect();
  menu.style.left = (btnR.left - contentR.left) + 'px';
  menu.style.top = (btnR.bottom - contentR.top + 4) + 'px';
  menu.style.display = '';
}

function closeCopyMenu() {
  document.getElementById('frame-copy-menu').style.display = 'none';
  copyMenuTarget = null;
}

function frameUrl(rec, format) {
  return `${window.location.origin}/api/v1/frames/${rec.id}.${format}`;
}

async function copyFrameUrl(rec, format) {
  const url = frameUrl(rec, format);
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`Ссылка (${format}) скопирована`);
  } catch (e) {
    setStatus(`Ошибка копирования: ${e.message}`, true);
  }
}

document.getElementById('frame-copy-menu').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn || !copyMenuTarget) return;
  const target = copyMenuTarget;
  closeCopyMenu();
  const fmt = btn.dataset.format;
  if (fmt === 'html' || fmt === 'png') copyFrameUrl(target, fmt);
});

document.addEventListener('mousedown', e => {
  const menu = document.getElementById('frame-copy-menu');
  if (menu.style.display !== 'none' && !menu.contains(e.target) && !e.target.closest('.board-frame-copy')) {
    closeCopyMenu();
  }
});

function scheduleElementSave(rec) {
  if (!currentBoardId) return;
  const boardId = currentBoardId;
  clearTimeout(elementSaveTimers.get(rec.id));
  elementSaveTimers.set(rec.id, setTimeout(async () => {
    elementSaveTimers.delete(rec.id);
    const data = {
      ...recToApiGeometry(rec),
      parentId: rec.parentId || null,
      updatedAt: Date.now(),
    };
    try {
      await api.patchElement(boardId, rec.id, data);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${e.message}`, true);
    }
  }, 1000));
}

async function loadBoards() {
  try {
    allBoards = await api.boards();
    if (!allBoards.length) {
      await createBoard('Доска 1');
    } else {
      const first = allBoards[0];
      currentBoardId = first.id;
      renderBoardsList();
      const full = await api.board(first.id);
      loadBoard(full.elements || []);
      if (!restoreViewport(first.id)) boardFitView();
      clearUndo();
    }
  } catch (e) {
    setStatus(`Не удалось загрузить доски: ${e.message}`, true);
  }
}

function renderBoardsList() {
  const list = document.getElementById('board-list');
  list.innerHTML = '';
  if (!allBoards.length) {
    list.innerHTML = '<div class="hint">Нет досок</div>';
    return;
  }
  for (const b of allBoards) {
    const item = document.createElement('div');
    item.className = 'board-item' + (b.id === currentBoardId ? ' active' : '');
    item.textContent = b.title || 'Без названия';
    item.addEventListener('click', () => { openBoard(b.id); closeSidebar(); });
    list.appendChild(item);
  }
}

async function openBoard(id) {
  if (currentBoardId === id) return;
  currentBoardId = id;
  renderBoardsList();
  try {
    const full = await api.board(id);
    loadBoard(full.elements || []);
    if (!restoreViewport(id)) boardFitView();
    clearUndo();
  } catch (e) {
    setStatus(`Ошибка загрузки доски: ${e.message}`, true);
    clearBoard();
  }
}

async function createBoard(title) {
  const t = title || `Доска ${allBoards.length + 1}`;
  const id = randomUUID();
  const now = Date.now();
  try {
    const board = await api.createBoard({ id, title: t, createdAt: now, updatedAt: now });
    allBoards = [board, ...allBoards];
    currentBoardId = id;
    clearBoard();
    clearUndo();
    renderBoardsList();
  } catch (e) {
    setStatus(`Ошибка создания доски: ${e.message}`, true);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.board-tool').forEach(el => {
  el.addEventListener('click', () => setBoardTool(el.dataset.tool));
});

document.getElementById('new-board-btn').addEventListener('click', () => { createBoard(); closeSidebar(); });

function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
function closeSidebar() { document.body.classList.remove('board-sidebar-open'); }
function toggleSidebar() { document.body.classList.toggle('board-sidebar-open'); }
document.getElementById('board-sidebar-toggle').addEventListener('click', toggleSidebar);
document.getElementById('board-sidebar-backdrop').addEventListener('click', closeSidebar);

const zoomIndicator = document.getElementById('zoom-indicator');
const VIEWPORT_KEY = id => `board:viewport:${id}`;
let saveViewportTimer = null;
function saveViewportSoon(viewport) {
  if (!currentBoardId) return;
  clearTimeout(saveViewportTimer);
  saveViewportTimer = setTimeout(() => {
    try { localStorage.setItem(VIEWPORT_KEY(currentBoardId), JSON.stringify(viewport)); } catch {}
  }, 300);
}
function restoreViewport(boardId) {
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY(boardId));
    if (!raw) return false;
    const v = JSON.parse(raw);
    if (typeof v.vx === 'number' && typeof v.vy === 'number' && typeof v.zoom === 'number') {
      boardSetViewport(v);
      return true;
    }
  } catch {}
  return false;
}

initBoard(document.getElementById('board-canvas'), {
  getTool: () => boardTool,
  onToolUsed: clearBoardTool,
  onElementCreated: saveElementCreate,
  onElementChanged: scheduleElementSave,
  onCopyLink: openCopyMenu,
  onSelectionChanged: onBoardSelectionChanged,
  onMoveCommit: items => pushUndo({ kind: 'move', items }),
  onResizeCommit: op => pushUndo({ kind: 'resize', ...op }),
  onTextCommit: (rec, key, before, after) => pushUndo({
    kind: 'attrs', id: rec.id,
    before: { [key]: before },
    after: { [key]: after },
  }),
  onViewportChanged: viewport => {
    if (zoomIndicator) zoomIndicator.textContent = Math.round(viewport.zoom * 100) + '%';
    saveViewportSoon(viewport);
    // Контекст-меню — DOM-overlay в screen-coords, при pan/zoom надо репозиционировать.
    const menu = document.getElementById('board-context-menu');
    if (boardSelected && lastSelectedBbox && menu && menu.style.display !== 'none') {
      positionContextMenu(lastSelectedBbox);
    }
  },
});

document.getElementById('zoom-in-btn').addEventListener('click', boardZoomIn);
document.getElementById('zoom-out-btn').addEventListener('click', boardZoomOut);
document.getElementById('zoom-fit-btn').addEventListener('click', boardFitView);

buildContextMenu();

document.addEventListener('keydown', onBoardKeydown);
// Дублируем на window (capture) — на случай когда фокус ушёл к parent (iframe-сценарий из /tools/).
window.addEventListener('keydown', onBoardKeydown, true);
// Если board открыт в iframe из /tools/ и фокус остался у parent — parent шлёт нам
// keydown через postMessage. Реконструируем event-like объект и вызываем handler.
window.addEventListener('message', e => {
  const d = e.data;
  if (!d || !d.__toolsKey) return;
  onBoardKeydown({
    key: d.key, code: d.code,
    ctrlKey: !!d.ctrlKey, shiftKey: !!d.shiftKey, metaKey: !!d.metaKey, altKey: !!d.altKey,
    target: document.body,
    preventDefault: () => {},
  });
});

document.body.classList.add('board-on');

loadBoards();
