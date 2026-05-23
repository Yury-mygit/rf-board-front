import { initBoard, setBoardCursor, loadBoard, clearBoard, applyElementAttrs, deselect as boardDeselect, removeElements as boardRemoveElements, exitEdit as boardExitEdit, getAllSelected as boardGetAllSelected, getSelectedCount as boardGetSelectedCount, addFromApi as boardAddFromApi, setElementGeo as boardSetElementGeo, setElementParent as boardSetElementParent, getElementById as boardGetElementById, getChildrenOf as boardGetChildrenOf, setSelection as boardSetSelection, zoomIn as boardZoomIn, zoomOut as boardZoomOut, fitView as boardFitView, setViewport as boardSetViewport, worldToScreen as boardWorldToScreen, isEditing as boardIsEditing } from './board.js';

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

  const numInputHandler = (input, attrKey) => {
    input.addEventListener('change', e => {
      e.stopPropagation();
      if (!ctxMenuTarget) return;
      const before = ctxMenuTarget.attrs?.[attrKey];
      const after = +input.value;
      if (before === after) return;
      commitAttrChange(ctxMenuTarget, { [attrKey]: before }, { [attrKey]: after });
    });
    input.addEventListener('mousedown', e => e.stopPropagation());
  };
  numInputHandler(document.getElementById('ctx-rx'), 'rx');
  numInputHandler(document.getElementById('ctx-sw'), 'strokeWidth');
  numInputHandler(document.getElementById('ctx-line-sw'), 'strokeWidth');

  // Палитра цвета для line — переиспользуем общую палитру (как у rect.stroke).
  document.getElementById('ctx-line-color-btn').addEventListener('click', e => {
    e.stopPropagation();
    togglePalette('stroke');
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
    renderInspectPanel();
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
  document.getElementById('ctx-line-color-btn')?.classList.remove('active');
}

function togglePalette(prop) {
  const palette = document.getElementById('ctx-palette');
  if (ctxPaletteFor === prop) { closePalette(); return; }
  ctxPaletteFor = prop;
  palette.style.display = '';
  document.getElementById('ctx-fill-btn').classList.toggle('active', prop === 'fill');
  document.getElementById('ctx-stroke-btn').classList.toggle('active', prop === 'stroke');
  document.getElementById('ctx-color-btn').classList.toggle('active', prop === 'color');
  document.getElementById('ctx-line-color-btn')?.classList.toggle('active', prop === 'stroke');
  document.getElementById('ctx-opacity-row').style.display = (prop === 'color') ? 'none' : '';
  refreshContextUI();
}

function refreshContextUI() {
  if (!ctxMenuTarget) return;
  const a = ctxMenuTarget.attrs || {};
  if (ctxMenuTarget.type === 'rect' || ctxMenuTarget.type === 'note') {
    const isNote = ctxMenuTarget.type === 'note';
    const defaultFill = isNote ? '#fff8c6' : DEFAULT_FILL;
    const defaultStroke = isNote ? '#f1c40f' : DEFAULT_STROKE;
    const defaultRx = isNote ? 2 : 4;
    const defaultSw = isNote ? 1 : 2;
    const fill = a.fill !== undefined ? a.fill : defaultFill;
    const stroke = a.stroke !== undefined ? a.stroke : defaultStroke;
    const fillIcon = document.querySelector('#ctx-toolbar-rect .ctx-tool-fill');
    const strokeIcon = document.querySelector('#ctx-toolbar-rect .ctx-tool-stroke');
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
    document.getElementById('ctx-rx').value = a.rx !== undefined ? a.rx : defaultRx;
    document.getElementById('ctx-sw').value = a.strokeWidth !== undefined ? a.strokeWidth : defaultSw;
  } else if (ctxMenuTarget.type === 'line') {
    const stroke = a.stroke !== undefined ? a.stroke : '#212529';
    const strokeIcon = document.querySelector('#ctx-toolbar-line .ctx-tool-stroke');
    if (strokeIcon) {
      if (stroke === null) {
        strokeIcon.classList.add('no-color');
        strokeIcon.style.borderColor = '#adb5bd';
      } else {
        strokeIcon.classList.remove('no-color');
        strokeIcon.style.borderColor = stroke;
      }
    }
    document.getElementById('ctx-line-sw').value = a.strokeWidth !== undefined ? a.strokeWidth : 2;
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
  const tbLine = document.getElementById('ctx-toolbar-line');
  const supported = rec && (rec.type === 'rect' || rec.type === 'text'
                            || rec.type === 'note' || rec.type === 'line');
  if (!supported) {
    hideContextMenu();
    return;
  }
  if (ctxMenuTarget && ctxMenuTarget.type !== rec.type) closePalette();
  ctxMenuTarget = rec;
  menu.style.display = '';
  // rect/note используют один toolbar (fill/stroke + rx/sw).
  tbRect.style.display = (rec.type === 'rect' || rec.type === 'note') ? '' : 'none';
  tbText.style.display = rec.type === 'text' ? '' : 'none';
  tbLine.style.display = rec.type === 'line' ? '' : 'none';
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
  renderInspectPanel();
}

// ── Inspect panel (правая) ──────────────────────────────────────────────────

const inspectBody = document.querySelector('#inspect-panel .ip-body');
const IP_EMPTY = '<div class="ip-empty">Выделите элемент, чтобы увидеть его свойства.</div>';

function ipEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ipRound(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return Math.round(v).toString();
}

function ipRow(label, value, copyVal) {
  const c = copyVal !== undefined ? copyVal : value;
  return `<div class="ip-row"><label>${ipEsc(label)}</label><span class="ip-val" data-copy="${ipEsc(c)}">${ipEsc(value)}</span></div>`;
}

function ipBBox(recs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of recs) {
    let x1, y1, x2, y2;
    if (r.type === 'line') {
      x1 = Math.min(r.x1, r.x2); y1 = Math.min(r.y1, r.y2);
      x2 = Math.max(r.x1, r.x2); y2 = Math.max(r.y1, r.y2);
    } else {
      x1 = r.x; y1 = r.y; x2 = r.x + r.w; y2 = r.y + r.h;
    }
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function ipRenderHeader(rec) {
  const shortId = rec.id.slice(0, 8) + '…';
  return `
    <div class="ip-section">
      ${ipRow('type', rec.type, rec.type)}
      <div class="ip-row"><label>id</label>
        <span class="ip-val" data-copy="${ipEsc(rec.id)}" title="${ipEsc(rec.id)}">${ipEsc(shortId)}</span>
      </div>
    </div>
  `;
}

function ipRenderGeometry(rec) {
  let rows = '';
  if (rec.type === 'line') {
    rows = ipRow('X1', ipRound(rec.x1), rec.x1) +
           ipRow('Y1', ipRound(rec.y1), rec.y1) +
           ipRow('X2', ipRound(rec.x2), rec.x2) +
           ipRow('Y2', ipRound(rec.y2), rec.y2);
  } else {
    rows = ipRow('X', ipRound(rec.x), rec.x) +
           ipRow('Y', ipRound(rec.y), rec.y) +
           ipRow('W', ipRound(rec.w), rec.w) +
           ipRow('H', ipRound(rec.h), rec.h);
    if (rec.parentId) {
      const parent = boardGetElementById(rec.parentId);
      if (parent) {
        rows += ipRow('Xrel', ipRound(rec.x - parent.x), rec.x - parent.x);
        rows += ipRow('Yrel', ipRound(rec.y - parent.y), rec.y - parent.y);
      }
    }
  }
  return `<div class="ip-section"><h4>Geometry</h4>${rows}</div>`;
}

function ipColorRow(label, value) {
  // value: null | undefined → 'none' (checkerboard swatch). иначе hex/url.
  const isNone = value == null || value === 'none';
  const display = isNone ? 'none' : String(value);
  const swatchStyle = isNone ? '' : `background:${display}`;
  return `
    <div class="ip-row">
      <label>${ipEsc(label)}</label>
      <span class="ip-swatch" style="${ipEsc(swatchStyle)}"></span>
      <span class="ip-val" data-copy="${ipEsc(display)}">${ipEsc(display)}</span>
    </div>
  `;
}

function ipNumRow(label, value, hideIfDefault) {
  if (value == null || value === '' || (hideIfDefault !== undefined && value === hideIfDefault)) return '';
  return ipRow(label, ipRound(value), value);
}

function ipRenderStyle(rec) {
  const a = rec.attrs || {};
  let rows = '';
  if (rec.type === 'rect' || rec.type === 'frame' || rec.type === 'note') {
    rows += ipColorRow('Fill', a.fill);
    rows += ipColorRow('Stroke', a.stroke);
    rows += ipNumRow('rx', a.rx);
    rows += ipNumRow('sw', a.strokeWidth);
    rows += ipNumRow('opacity', a.fillOpacity, 1);
  } else if (rec.type === 'line') {
    rows += ipColorRow('Stroke', a.stroke);
    rows += ipNumRow('sw', a.strokeWidth);
    rows += ipNumRow('opacity', a.strokeOpacity, 1);
  } else if (rec.type === 'text') {
    rows += ipColorRow('Color', a.color);
    rows += ipNumRow('opacity', a.opacity, 1);
  }
  if (!rows) return '';
  return `<div class="ip-section"><h4>Style</h4>${rows}</div>`;
}

function ipBoolRow(label, value) {
  return `<div class="ip-row"><label>${ipEsc(label)}</label><span>${value ? '✓' : '—'}</span></div>`;
}

function ipPreview(text, max = 80) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function ipRenderText(rec) {
  if (rec.type !== 'text' && rec.type !== 'note') return '';
  const a = rec.attrs || {};
  const content = a.text || '';
  let rows = '';
  rows += ipNumRow('fontSize', a.fontSize || 14);
  rows += ipBoolRow('bold', !!a.bold);
  if (rec.type === 'text') {
    rows += ipBoolRow('italic', !!a.italic);
    rows += ipBoolRow('underline', !!a.underline);
  }
  rows += `
    <div class="ip-row"><label>text</label>
      <span class="ip-val" data-copy="${ipEsc(content)}" title="${ipEsc(content)}">${ipEsc(ipPreview(content))}</span>
    </div>
  `;
  return `<div class="ip-section"><h4>Text</h4>${rows}</div>`;
}

function ipRenderImage(rec) {
  if (rec.type !== 'image') return '';
  const a = rec.attrs || {};
  const src = a.src || '';
  return `
    <div class="ip-section">
      <h4>Image</h4>
      <div class="ip-row"><label>src</label>
        <span class="ip-val" data-copy="${ipEsc(src)}" title="${ipEsc(src)}">${ipEsc(ipPreview(src, 60))}</span>
      </div>
    </div>
  `;
}

function ipRenderFrame(rec) {
  if (rec.type !== 'frame') return '';
  const a = rec.attrs || {};
  const title = a.title || '';
  const children = boardGetChildrenOf(rec.id);
  const types = {};
  for (const c of children) types[c.type] = (types[c.type] || 0) + 1;
  const breakdown = Object.entries(types).map(([t, n]) => `${t} ×${n}`).join(', ') || '—';
  return `
    <div class="ip-section">
      <h4>Frame</h4>
      <div class="ip-row"><label>title</label>
        <span class="ip-val" data-copy="${ipEsc(title)}" title="${ipEsc(title)}">${ipEsc(ipPreview(title, 36)) || '—'}</span>
      </div>
      <div class="ip-row"><label>children</label><span>${children.length}</span></div>
      <div class="ip-row"><label>types</label><span>${ipEsc(breakdown)}</span></div>
    </div>
  `;
}

function ipRenderSingle(rec) {
  return ipRenderHeader(rec)
       + ipRenderGeometry(rec)
       + ipRenderStyle(rec)
       + ipRenderText(rec)
       + ipRenderImage(rec)
       + ipRenderFrame(rec);
}

function ipCoords(rec) {
  // Координаты относительно родителя-фрейма (если есть), иначе world.
  if (rec.parentId) {
    const parent = boardGetElementById(rec.parentId);
    if (parent) return { x: rec.x - parent.x, y: rec.y - parent.y };
  }
  return { x: rec.x, y: rec.y };
}

function ipRecToCss(rec) {
  if (rec.type === 'line') return null;
  const a = rec.attrs || {};
  const { x, y } = ipCoords(rec);
  const lines = [
    'position: absolute;',
    `left: ${Math.round(x)}px;`,
    `top: ${Math.round(y)}px;`,
    `width: ${Math.round(rec.w)}px;`,
    `height: ${Math.round(rec.h)}px;`,
  ];
  if (rec.type === 'image' && a.src) {
    lines.push(`background-image: url(${a.src});`);
    lines.push('background-size: cover;');
    lines.push('background-position: center;');
  } else if (a.fill != null && a.fill !== 'none') {
    lines.push(`background: ${a.fill};`);
  }
  if (a.stroke != null && a.stroke !== 'none' && (a.strokeWidth || 0) > 0) {
    lines.push(`border: ${a.strokeWidth}px solid ${a.stroke};`);
  }
  if (a.rx != null && a.rx > 0) {
    lines.push(`border-radius: ${a.rx}px;`);
  }
  if (a.fillOpacity != null && a.fillOpacity !== 1) {
    lines.push(`opacity: ${a.fillOpacity};`);
  }
  if (rec.type === 'text' || rec.type === 'note') {
    if (a.fontSize) lines.push(`font-size: ${a.fontSize}px;`);
    if (a.bold) lines.push('font-weight: 700;');
    if (a.italic) lines.push('font-style: italic;');
    if (a.underline) lines.push('text-decoration: underline;');
    if (a.color != null && a.color !== 'none') lines.push(`color: ${a.color};`);
  }
  return lines.join('\n');
}

function ipBuildCss(selected) {
  if (selected.length === 1) return ipRecToCss(selected[0]);
  const bb = ipBBox(selected);
  return [
    'position: absolute;',
    `left: ${Math.round(bb.x)}px;`,
    `top: ${Math.round(bb.y)}px;`,
    `width: ${Math.round(bb.w)}px;`,
    `height: ${Math.round(bb.h)}px;`,
  ].join('\n');
}

function ipRenderCssFooter(selected) {
  // Для single-line не показываем (CSS не поддерживается).
  if (selected.length === 1 && selected[0].type === 'line') return '';
  return `<div class="ip-footer"><button class="ip-copy-css" type="button">Скопировать как CSS</button></div>`;
}

function ipAttachCssCopy() {
  const btn = inspectBody.querySelector('.ip-copy-css');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const sel = boardGetAllSelected();
    const css = ipBuildCss(sel);
    if (css == null) {
      setStatus('CSS для этого типа не генерируется', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(css);
      const orig = btn.textContent;
      btn.textContent = '✓ CSS скопирован';
      setTimeout(() => { btn.textContent = orig; }, 900);
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`, true);
    }
  });
}

function ipRenderMulti(recs) {
  const bb = ipBBox(recs);
  const types = {};
  for (const r of recs) types[r.type] = (types[r.type] || 0) + 1;
  const breakdown = Object.entries(types).map(([t, c]) => `${t} ×${c}`).join(', ');
  return `
    <div class="ip-section">
      <h4>Selection</h4>
      <div class="ip-row"><label>count</label><span>${recs.length}</span></div>
      <div class="ip-row"><label>types</label><span>${ipEsc(breakdown)}</span></div>
    </div>
    <div class="ip-section">
      <h4>Bounding box</h4>
      ${ipRow('X', ipRound(bb.x), bb.x)}
      ${ipRow('Y', ipRound(bb.y), bb.y)}
      ${ipRow('W', ipRound(bb.w), bb.w)}
      ${ipRow('H', ipRound(bb.h), bb.h)}
    </div>
  `;
}

function ipAttachCopyHandlers() {
  inspectBody.querySelectorAll('.ip-val[data-copy]').forEach(el => {
    el.addEventListener('click', async () => {
      const val = el.dataset.copy;
      try {
        await navigator.clipboard.writeText(val);
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 600);
      } catch (err) {
        setStatus(`Copy failed: ${err.message}`, true);
      }
    });
  });
}

function renderInspectPanel() {
  if (!inspectBody) return;
  const selected = boardGetAllSelected();
  if (!selected.length) {
    inspectBody.innerHTML = IP_EMPTY;
    return;
  }
  const body = selected.length === 1
    ? ipRenderSingle(selected[0])
    : ipRenderMulti(selected);
  inspectBody.innerHTML = body + ipRenderCssFooter(selected);
  ipAttachCopyHandlers();
  ipAttachCssCopy();
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

// ── Copy / paste (custom MIME) ───────────────────────────────────────────────
// При copy кладём в clipboard JSON в нашем формате application/x-rfboard-items
// + plain-text fallback. При paste читаем свой MIME → создаём новые элементы
// с remap'нутыми ID, сохраняя parent-child связи фреймов. Сдвиг (+24, +24)
// чтобы было видно, что это копия.
const CLIP_MIME = 'application/x-rfboard-items';
const PASTE_OFFSET = 24;

function isEditableTarget(t) {
  if (!t || !t.closest) return false;
  return !!t.closest('textarea, input, [contenteditable="true"]');
}

function collectForCopy() {
  const selected = boardGetAllSelected();
  if (!selected.length) return null;
  const visited = new Set();
  const items = [];
  function add(el) {
    if (visited.has(el.id)) return;
    visited.add(el.id);
    items.push(snapshotRec(el));
    if (el.type === 'frame') {
      for (const child of boardGetChildrenOf(el.id)) add(child);
    }
  }
  for (const el of selected) add(el);
  return { version: 1, items };
}

document.addEventListener('copy', (e) => {
  if (isEditableTarget(e.target)) return;
  if (!boardGetSelectedCount()) return;
  const payload = collectForCopy();
  if (!payload) return;
  e.clipboardData.setData(CLIP_MIME, JSON.stringify(payload));
  e.clipboardData.setData('text/plain', `[rfboard ${payload.items.length} elements]`);
  e.preventDefault();
});

document.addEventListener('paste', async (e) => {
  if (isEditableTarget(e.target)) return;
  const json = e.clipboardData.getData(CLIP_MIME);
  if (!json || !currentBoardId) return;
  e.preventDefault();

  let payload;
  try { payload = JSON.parse(json); }
  catch { setStatus('Не удалось прочитать данные из буфера', true); return; }
  if (!payload || !Array.isArray(payload.items) || !payload.items.length) return;

  const idMap = new Map();
  for (const it of payload.items) idMap.set(it.id, randomUUID());

  const records = [];
  const now = Date.now();
  for (const it of payload.items) {
    const newId = idMap.get(it.id);
    const oldParent = it.parentId || null;
    const newParent = oldParent && idMap.has(oldParent) ? idMap.get(oldParent) : null;
    const apiRec = {
      id: newId, type: it.type,
      parentId: newParent,
      x: it.x + PASTE_OFFSET, y: it.y + PASTE_OFFSET,
      w: it.w, h: it.h,
      attrs: { ...(it.attrs || {}) },
      createdAt: now, updatedAt: now,
    };
    try {
      await api.createElement(currentBoardId, apiRec);
      boardAddFromApi(apiRec);
      records.push(apiRec);
    } catch (err) {
      setStatus(`Ошибка вставки: ${err.message}`, true);
      return;
    }
  }

  pushUndo({ kind: 'create', records });

  // Выделяем только корневые (без parentId либо с parent'ом не из buffer'а).
  const rootIds = records.filter(r => !r.parentId).map(r => r.id);
  const els = rootIds.map(id => boardGetElementById(id)).filter(Boolean);
  if (els.length) boardSetSelection(els);

  setStatus(`Вставлено ${records.length} элементов`);
});

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
  renderInspectPanel();
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
  renderInspectPanel();
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
  onElementChanged: (rec) => { scheduleElementSave(rec); renderInspectPanel(); },
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
