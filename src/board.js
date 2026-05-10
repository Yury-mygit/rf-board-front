// Board (whiteboard) — рисование и манипуляция примитивами на SVG.
// Состояние держится здесь; внешний код (main.js) синкает с backend через callbacks.
//
// Геометрия в API: x, y — точка-якорь; w, h — размер.
// Для line: (x, y) = первая точка, (x+w, y+h) = вторая (w/h могут быть отрицательными).
// parentId: только для фреймов (frame containment, как в Miro).

const SVG_NS = 'http://www.w3.org/2000/svg';

let svg = null;
// Viewport в мировых координатах: (vx, vy) — левый-верхний угол видимого
// окна, zoom — увеличение (1 = 1px экрана = 1 единица мира). Координаты
// элементов в БД трактуются как мировые (без миграции).
let viewport = { vx: 0, vy: 0, zoom: 1 };
let panMode = false;  // Space зажат → LMB-drag = pan
let pan = null;       // активный pan: { startVx, startVy, startClientX, startClientY }
let getTool = () => null;
let onToolUsed = () => {};
let onElementCreated = () => {};
let onElementChanged = () => {};
let onCopyLink = () => {};
let onSelectionChanged = () => {};
let onMoveCommit = () => {};
let onResizeCommit = () => {};
let onTextCommit = () => {};
let elements = [];
let drag = null;     // создание нового элемента
let move = null;     // перемещение существующего
let resize = null;   // resize фрейма за handle
let rubber = null;   // rubber-band selection (drag по пустому месту)
let selectedIds = new Set(); // id'ы выбранных элементов
let editing = null;  // text/note в режиме редактирования (input доступен)
let frameTarget = null; // фрейм-цель при drag (для подсветки)
let handlesG = null; // <g> с 8 resize-handles, всегда поверх

function getOnlySelected() {
  if (selectedIds.size !== 1) return null;
  const id = selectedIds.values().next().value;
  return elements.find(e => e.id === id) || null;
}

export function getAllSelected() {
  return elements.filter(e => selectedIds.has(e.id));
}

export function getSelectedCount() {
  return selectedIds.size;
}

const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_SIZE = 10;
const FRAME_MIN = 20;
const TEXT_MIN_W = 40;     // ~3 символа
const TEXT_H = 32;
const TEXT_FONT = '14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FRAME_TITLE_MIN_W = 40;
const FRAME_TITLE_FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

let measureCanvas = null;
function measureWidth(s, font) {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(s || '').width;
}

function textFont(rec) {
  const a = rec.attrs || {};
  const size = a.fontSize || 14;
  const weight = a.bold ? 'bold' : 'normal';
  const style = a.italic ? 'italic' : 'normal';
  return `${style} ${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

function resizeTextWidth(rec) {
  const input = rec.node.querySelector('input.board-text-input');
  if (!input) return;
  const a = rec.attrs || {};
  const size = a.fontSize || 14;
  const w = Math.max(TEXT_MIN_W, Math.ceil(measureWidth(input.value, textFont(rec)) + 10));
  const h = Math.max(TEXT_H, Math.ceil(size * 1.6));
  const fo = rec.node.querySelector('foreignObject');
  const hit = rec.node.querySelector('.board-edit-hit');
  if (rec.w !== w) {
    rec.w = w;
    if (fo) fo.setAttribute('width', w);
    if (hit) hit.setAttribute('width', w);
  }
  if (rec.h !== h) {
    rec.h = h;
    if (fo) {
      fo.setAttribute('height', h);
      fo.setAttribute('y', rec.y - h / 2);
    }
    if (hit) {
      hit.setAttribute('height', h);
      hit.setAttribute('y', rec.y - h / 2);
    }
  }
}

function resizeFrameTitleWidth(rec) {
  const fo = rec.node.querySelector('foreignObject.board-frame-title-fo');
  const input = rec.node.querySelector('input.board-frame-title');
  if (!fo || !input) return;
  const text = input.value || input.placeholder || '';
  // запас 32 = ~10 padding + ~18 кнопка copy + ~4 gap
  const w = Math.max(FRAME_TITLE_MIN_W + 22, Math.ceil(measureWidth(text, FRAME_TITLE_FONT) + 32));
  fo.setAttribute('width', w);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

export function initBoard(container, opts = {}) {
  if (opts.getTool) getTool = opts.getTool;
  if (opts.onToolUsed) onToolUsed = opts.onToolUsed;
  if (opts.onElementCreated) onElementCreated = opts.onElementCreated;
  if (opts.onElementChanged) onElementChanged = opts.onElementChanged;
  if (opts.onCopyLink) onCopyLink = opts.onCopyLink;
  if (opts.onSelectionChanged) onSelectionChanged = opts.onSelectionChanged;
  if (opts.onMoveCommit) onMoveCommit = opts.onMoveCommit;
  if (opts.onResizeCommit) onResizeCommit = opts.onResizeCommit;
  if (opts.onTextCommit) onTextCommit = opts.onTextCommit;
  if (opts.onViewportChanged) onViewportChanged = opts.onViewportChanged;

  container.innerHTML = '';
  svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('board-svg');
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  container.appendChild(svg);

  handlesG = createHandles();
  svg.appendChild(handlesG);

  applyViewBox();
  const ro = new ResizeObserver(() => applyViewBox());
  ro.observe(container);

  svg.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  // Если Space был отпущен вне страницы, флаг может застрять — сбрасываем по blur.
  window.addEventListener('blur', () => { if (panMode) { panMode = false; refreshCursor(); } });
}

function applyViewBox() {
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const vw = rect.width / viewport.zoom;
  const vh = rect.height / viewport.zoom;
  svg.setAttribute('viewBox', `${viewport.vx} ${viewport.vy} ${vw} ${vh}`);
  refreshHandlesIfVisible();
  onViewportChanged({ ...viewport });
}

export function getZoom() { return viewport.zoom; }
export function getViewport() { return { ...viewport }; }
export function setViewport(v) {
  if (typeof v.vx === 'number') viewport.vx = v.vx;
  if (typeof v.vy === 'number') viewport.vy = v.vy;
  if (typeof v.zoom === 'number') viewport.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom));
  applyViewBox();
}

export function zoomIn() {
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  setZoomAt(r.left + r.width / 2, r.top + r.height / 2, viewport.zoom * ZOOM_STEP);
}

export function zoomOut() {
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  setZoomAt(r.left + r.width / 2, r.top + r.height / 2, viewport.zoom / ZOOM_STEP);
}

// Вписать bbox всех элементов в viewport с 5% padding. Если пусто — сбрасываем
// в дефолт (0,0, zoom=1).
export function fitView() {
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  if (elements.length === 0) {
    viewport = { vx: 0, vy: 0, zoom: 1 };
    applyViewBox();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    const b = bboxOf(el);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);
  const pad = 0.05;
  const z = Math.min(r.width / (bboxW * (1 + 2 * pad)), r.height / (bboxH * (1 + 2 * pad)));
  viewport.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  // Центрируем bbox в viewport.
  viewport.vx = minX - (r.width / viewport.zoom - bboxW) / 2;
  viewport.vy = minY - (r.height / viewport.zoom - bboxH) / 2;
  applyViewBox();
}

function screenToWorld(clientX, clientY) {
  const r = svg.getBoundingClientRect();
  return {
    x: viewport.vx + (clientX - r.left) / viewport.zoom,
    y: viewport.vy + (clientY - r.top) / viewport.zoom,
  };
}

// Обратная конверсия для DOM-overlays (контекст-меню и т.п.).
// Возвращает client-координаты (как clientX/clientY).
export function worldToScreen(wx, wy) {
  if (!svg) return { x: 0, y: 0 };
  const r = svg.getBoundingClientRect();
  return {
    x: r.left + (wx - viewport.vx) * viewport.zoom,
    y: r.top + (wy - viewport.vy) * viewport.zoom,
  };
}

function refreshCursor() {
  if (!svg) return;
  if (pan) svg.style.cursor = 'grabbing';
  else if (panMode) svg.style.cursor = 'grab';
  else svg.style.cursor = getTool() ? 'crosshair' : 'default';
}

function startPan(clientX, clientY) {
  pan = {
    startVx: viewport.vx,
    startVy: viewport.vy,
    startClientX: clientX,
    startClientY: clientY,
  };
  refreshCursor();
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.2;
let onViewportChanged = () => {};

// Wheel: Ctrl+wheel (или pinch-зум на трекпаде, который браузер шлёт как
// wheel с ctrlKey=true) → zoom вокруг курсора. Иначе → pan (deltaX/deltaY).
function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey) {
    setZoomAt(e.clientX, e.clientY, viewport.zoom * Math.exp(-e.deltaY / 500));
    return;
  }
  viewport.vx += e.deltaX / viewport.zoom;
  viewport.vy += e.deltaY / viewport.zoom;
  applyViewBox();
}

// Установить zoom так, чтобы точка под (clientX, clientY) осталась на месте.
function setZoomAt(clientX, clientY, targetZoom) {
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom));
  if (newZoom === viewport.zoom) return;
  const before = screenToWorld(clientX, clientY);
  viewport.zoom = newZoom;
  const after = screenToWorld(clientX, clientY);
  viewport.vx += before.x - after.x;
  viewport.vy += before.y - after.y;
  applyViewBox();
}

function onKeyDown(e) {
  if (e.code !== 'Space' || panMode) return;
  const ae = document.activeElement;
  // Не активируем pan если фокус в поле ввода — там Space печатает пробел.
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  e.preventDefault();
  panMode = true;
  refreshCursor();
}

function onKeyUp(e) {
  if (e.code !== 'Space' || !panMode) return;
  panMode = false;
  refreshCursor();
}

function handleSize() { return HANDLE_SIZE / viewport.zoom; }

function createHandles() {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('board-resize-handles');
  g.style.display = 'none';
  for (const name of HANDLE_NAMES) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.classList.add('resize-handle');
    r.dataset.handle = name;
    g.appendChild(r);
  }
  return g;
}

function showHandlesFor(frame) {
  updateHandles(frame);
  handlesG.style.display = '';
  svg.appendChild(handlesG); // перенести в конец, чтобы быть поверх
}

function hideHandles() {
  handlesG.style.display = 'none';
}

function updateHandles(frame) {
  const b = bboxOf(frame);
  const positions = {
    nw: [b.x,           b.y],
    n:  [b.x + b.w / 2, b.y],
    ne: [b.x + b.w,     b.y],
    e:  [b.x + b.w,     b.y + b.h / 2],
    se: [b.x + b.w,     b.y + b.h],
    s:  [b.x + b.w / 2, b.y + b.h],
    sw: [b.x,           b.y + b.h],
    w:  [b.x,           b.y + b.h / 2],
  };
  const hs = handleSize();
  for (const r of handlesG.querySelectorAll('.resize-handle')) {
    const [x, y] = positions[r.dataset.handle];
    r.setAttribute('width', hs);
    r.setAttribute('height', hs);
    r.setAttribute('x', x - hs / 2);
    r.setAttribute('y', y - hs / 2);
  }
}

function refreshHandlesIfVisible() {
  if (!handlesG || handlesG.style.display === 'none') return;
  const sel = getOnlySelected();
  if (sel && (sel.type === 'frame' || sel.type === 'rect')) updateHandles(sel);
}

export function setBoardCursor(tool) {
  refreshCursor();
}

export function clearBoard() {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (handlesG) {
    hideHandles();
    svg.appendChild(handlesG);
  }
  elements = [];
  selectedIds = new Set();
  drag = null;
  move = null;
  resize = null;
  rubber = null;
  frameTarget = null;
}

export function loadBoard(apiElements) {
  clearBoard();
  for (const e of apiElements) renderFromApi(e);
}

// Добавить элемент из API-формата (используется при redo create / undo delete).
export function addFromApi(e) {
  renderFromApi(e);
}

function renderFromApi(e) {
  const attrs = e.attrs || {};
  const parentId = e.parentId || null;
  if (e.type === 'rect' || e.type === 'frame') {
    const node = createShape(e.type);
    setRectAttrs(node, e.x, e.y, e.w, e.h);
    svg.appendChild(node);
    const rec = register({ id: e.id, type: e.type, node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId });
    if (e.type === 'frame') attachFrameTitleListener(rec);
    applyElementAttrs(rec);
    return;
  }
  if (e.type === 'line') {
    const node = createShape('line');
    node.setAttribute('x1', e.x);
    node.setAttribute('y1', e.y);
    node.setAttribute('x2', e.x + e.w);
    node.setAttribute('y2', e.y + e.h);
    svg.appendChild(node);
    register({
      id: e.id, type: 'line', node,
      x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h,
      attrs, parentId,
    });
    return;
  }
  if (e.type === 'text') {
    const rec = placeText(e.x, e.y, { id: e.id, text: attrs.text || '', focus: false, parentId });
    rec.attrs = attrs;
    applyElementAttrs(rec);
    return;
  }
  if (e.type === 'note') {
    const rec = placeNote(e.x, e.y, { id: e.id, w: e.w, h: e.h, text: attrs.text || '', focus: false, parentId });
    rec.attrs = attrs;
    applyElementAttrs(rec);
  }
}

function point(e) {
  return screenToWorld(e.clientX, e.clientY);
}

function findShape(target) {
  const node = target.closest('.board-shape');
  if (!node) return null;
  return elements.find(el => el.node === node) || null;
}

function canMove(el) {
  return el.type === 'line' || el.type === 'rect' || el.type === 'frame'
      || el.type === 'text' || el.type === 'note';
}

function enterEdit(rec) {
  if (editing === rec) return;
  exitEdit();
  editing = rec;
  const input = rec.node.querySelector('input, textarea');
  const hit = rec.node.querySelector('.board-edit-hit');
  if (hit) hit.style.display = 'none';
  if (input) {
    input.style.pointerEvents = 'auto';
    input.focus();
  }
}

export function isEditing() { return editing !== null; }

export function exitEdit() {
  if (!editing) return;
  const input = editing.node.querySelector('input, textarea');
  const hit = editing.node.querySelector('.board-edit-hit');
  if (hit) hit.style.display = '';
  if (input) {
    input.style.pointerEvents = '';
    input.blur();
  }
  editing = null;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function bboxOf(rec) {
  if (rec.type === 'line') {
    return {
      x: Math.min(rec.x1, rec.x2),
      y: Math.min(rec.y1, rec.y2),
      w: Math.abs(rec.x2 - rec.x1),
      h: Math.abs(rec.y2 - rec.y1),
    };
  }
  return { x: rec.x, y: rec.y, w: rec.w, h: rec.h };
}

function centerOf(rec) {
  const b = bboxOf(rec);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function pointInBox(p, b) {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

// Top-most frame whose bbox contains the point. Excludes `exclude` (e.g. self).
function frameAt(p, exclude) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el === exclude) continue;
    if (el.type !== 'frame') continue;
    if (pointInBox(p, bboxOf(el))) return el;
  }
  return null;
}

function frameContaining(rec) {
  return frameAt(centerOf(rec), rec);
}

function setFrameTarget(frame) {
  if (frameTarget === frame) return;
  if (frameTarget) frameTarget.node.classList.remove('frame-target');
  frameTarget = frame;
  if (frameTarget) frameTarget.node.classList.add('frame-target');
}

function childrenOf(parentId) {
  return elements.filter(el => el.parentId === parentId);
}

// ── Mouse handlers ───────────────────────────────────────────────────────────

function onDown(e) {
  // Если board открыт в iframe (например, через /tools/), click на SVG не передаёт
  // фокус iframe element (SVG не focusable). Без фокуса keydown идут к parent.
  // window.focus() внутри iframe — same-origin, всегда работает; parent видит iframe как activeElement.
  window.focus();

  // Pan: middle-mouse либо Space+LMB. Имеет приоритет над всем (включая tool).
  if (e.button === 1 || (panMode && e.button === 0)) {
    e.preventDefault();
    startPan(e.clientX, e.clientY);
    return;
  }

  const tool = getTool();
  const p = point(e);

  // Любой клик мимо текущего editing input → выходим из edit-режима.
  if (editing) {
    const editingInput = editing.node.querySelector('input, textarea');
    if (!editingInput || !editingInput.contains(e.target)) exitEdit();
  }

  // Если фокус «застрял» в каком-то input/textarea (например, frame title),
  // снимаем — иначе Delete на клавиатуре печатает в инпут вместо удаления элемента.
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && ae !== e.target && !ae.contains(e.target)) {
    ae.blur();
  }

  // Handle resize-handle первым: имеет приоритет над shape-кликом.
  const handleEl = e.target.closest('.resize-handle');
  const onlySel = getOnlySelected();
  if (handleEl && onlySel && (onlySel.type === 'frame' || onlySel.type === 'rect')) {
    const b = bboxOf(onlySel);
    resize = {
      el: onlySel,
      handle: handleEl.dataset.handle,
      oldX: b.x, oldY: b.y, oldW: b.w, oldH: b.h,
      before: snapshotGeoLocal(onlySel),
      // Для frame — снимаем parent_id всех потенциальных детей, чтобы потом diff'нуть после recompute.
      childParentsBefore: onlySel.type === 'frame'
        ? new Map(elements.filter(el => el !== onlySel && el.type !== 'frame').map(el => [el.id, el.parentId || null]))
        : null,
    };
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (tool) {
    if (e.target.closest('input, textarea')) return;
    if (tool === 'text') { placeText(p.x, p.y); onToolUsed(); e.preventDefault(); return; }
    if (tool === 'note') { placeNote(p.x, p.y); onToolUsed(); e.preventDefault(); return; }
    drag = { type: tool, x1: p.x, y1: p.y, node: null };
    e.preventDefault();
    return;
  }

  if (e.target.closest('input, textarea')) return;
  const shape = findShape(e.target);
  if (shape) {
    const wasInSelection = selectedIds.has(shape.id);
    if (e.shiftKey) {
      // Toggle membership; move не начинаем.
      if (wasInSelection) {
        setSelection(getAllSelected().filter(r => r.id !== shape.id));
      } else {
        setSelection([...getAllSelected(), shape]);
      }
      e.preventDefault();
      return;
    }
    if (!wasInSelection) {
      selectShape(shape);
    }
    // Если был в selection (single или multi) — selection оставляем как есть,
    // даём начать move. Свёртывание multi → single произойдёт в onUp при click без drag.
    if (canMove(shape)) {
      const prepIds = collectMoveTargets(shape, wasInSelection);
      const before = new Map();
      for (const id of prepIds) {
        const el = elements.find(e => e.id === id);
        if (el) before.set(id, snapshotGeoLocal(el));
      }
      move = { el: shape, lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, wasInSelection, before };
    }
    e.preventDefault();
  } else {
    // Пустое место без инструмента → старт rubber-band.
    // Свёртывание/deselect произойдёт в onUp при коротком click без shift.
    rubber = {
      startX: p.x, startY: p.y,
      shift: e.shiftKey,
      node: null,
      initialSelection: e.shiftKey ? new Set(selectedIds) : null,
    };
    e.preventDefault();
  }
}

function onMove(e) {
  if (pan) {
    viewport.vx = pan.startVx - (e.clientX - pan.startClientX) / viewport.zoom;
    viewport.vy = pan.startVy - (e.clientY - pan.startClientY) / viewport.zoom;
    applyViewBox();
    return;
  }
  const p = point(e);
  if (rubber) {
    if (!rubber.node) {
      rubber.node = document.createElementNS(SVG_NS, 'rect');
      rubber.node.classList.add('board-rubber');
      svg.appendChild(rubber.node);
    }
    const x = Math.min(rubber.startX, p.x);
    const y = Math.min(rubber.startY, p.y);
    const w = Math.abs(p.x - rubber.startX);
    const h = Math.abs(p.y - rubber.startY);
    rubber.node.setAttribute('x', x);
    rubber.node.setAttribute('y', y);
    rubber.node.setAttribute('width', w);
    rubber.node.setAttribute('height', h);
    return;
  }
  if (resize) {
    const r = resize;
    let nx = r.oldX, ny = r.oldY, nw = r.oldW, nh = r.oldH;
    const right = r.oldX + r.oldW, bottom = r.oldY + r.oldH;
    if (r.handle.includes('w')) { nx = p.x; nw = right - p.x; }
    if (r.handle.includes('e')) { nw = p.x - r.oldX; }
    if (r.handle.includes('n')) { ny = p.y; nh = bottom - p.y; }
    if (r.handle.includes('s')) { nh = p.y - r.oldY; }
    if (nw < FRAME_MIN) {
      if (r.handle.includes('w')) nx = right - FRAME_MIN;
      nw = FRAME_MIN;
    }
    if (nh < FRAME_MIN) {
      if (r.handle.includes('n')) ny = bottom - FRAME_MIN;
      nh = FRAME_MIN;
    }
    r.el.x = nx; r.el.y = ny; r.el.w = nw; r.el.h = nh;
    setRectAttrs(r.el.node, nx, ny, nw, nh);
    updateHandles(r.el);
    if (getOnlySelected() === r.el) onSelectionChanged(r.el, bboxOf(r.el));
    return;
  }
  if (drag) {
    if (!drag.node) {
      drag.node = createShape(drag.type);
      svg.appendChild(drag.node);
    }
    applyShape(drag.node, drag.type, drag.x1, drag.y1, p.x, p.y);
    // Подсветка фрейма-цели при создании (кроме самого фрейма)
    if (drag.type !== 'frame') {
      const tmp = bboxFromTwoPoints(drag.type, drag.x1, drag.y1, p.x, p.y);
      setFrameTarget(frameAt({ x: tmp.x + tmp.w / 2, y: tmp.y + tmp.h / 2 }, null));
    }
    return;
  }
  if (move) {
    const dx = p.x - move.lastX;
    const dy = p.y - move.lastY;
    move.lastX = p.x;
    move.lastY = p.y;
    const isGroupDrag = selectedIds.has(move.el.id) && selectedIds.size > 1;
    if (isGroupDrag) {
      // Все selected + дети-через-frame, без дублей.
      const movingIds = new Set();
      for (const sel of getAllSelected()) {
        movingIds.add(sel.id);
        if (sel.type === 'frame') {
          for (const child of childrenOf(sel.id)) movingIds.add(child.id);
        }
      }
      for (const id of movingIds) {
        const el = elements.find(e => e.id === id);
        if (!el) continue;
        moveBy(el, dx, dy);
        onElementChanged(el);
      }
      setFrameTarget(null); // containment отключён для group drag
    } else {
      moveBy(move.el, dx, dy);
      onElementChanged(move.el);
      if (move.el.type === 'frame') {
        for (const child of childrenOf(move.el.id)) {
          moveBy(child, dx, dy);
          onElementChanged(child);
        }
      } else {
        setFrameTarget(frameContaining(move.el));
      }
    }
    if (getOnlySelected() === move.el) {
      if (move.el.type === 'frame' || move.el.type === 'rect') updateHandles(move.el);
      onSelectionChanged(move.el, bboxOf(move.el));
    }
  }
}

function onUp(e) {
  if (pan) {
    pan = null;
    refreshCursor();
    return;
  }
  if (rubber) {
    const p = point(e);
    const dx = Math.abs(p.x - rubber.startX);
    const dy = Math.abs(p.y - rubber.startY);
    const small = dx < 3 && dy < 3;
    if (rubber.node) rubber.node.remove();
    if (small) {
      // Click мимо без drag → без shift deselect, с shift не трогаем.
      if (!rubber.shift) deselect();
      rubber = null;
      return;
    }
    const x1 = Math.min(rubber.startX, p.x);
    const y1 = Math.min(rubber.startY, p.y);
    const x2 = Math.max(rubber.startX, p.x);
    const y2 = Math.max(rubber.startY, p.y);
    const hits = elements.filter(el => {
      const b = bboxOf(el);
      if (el.type === 'frame') {
        // Фрейм — только если полностью внутри rubber-rect (Miro-style).
        return b.x >= x1 && b.y >= y1 && b.x + b.w <= x2 && b.y + b.h <= y2;
      }
      return b.x < x2 && b.x + b.w > x1 && b.y < y2 && b.y + b.h > y1;
    });
    if (rubber.shift) {
      const merged = new Set(rubber.initialSelection);
      for (const r of hits) merged.add(r.id);
      setSelection(elements.filter(e => merged.has(e.id)));
    } else {
      setSelection(hits);
    }
    rubber = null;
    return;
  }
  if (resize) {
    const target = resize.el;
    const before = resize.before;
    const childParentsBefore = resize.childParentsBefore;
    resize = null;
    if (target.type === 'frame') recomputeChildrenAfterResize(target);
    onElementChanged(target);
    const after = snapshotGeoLocal(target);
    const childParents = [];
    if (childParentsBefore) {
      for (const [id, prev] of childParentsBefore.entries()) {
        const elx = elements.find(e => e.id === id);
        if (!elx) continue;
        const cur = elx.parentId || null;
        if (cur !== prev) childParents.push({ id, before: prev, after: cur });
      }
    }
    if (!geoEqual(before, after) || childParents.length) {
      onResizeCommit({ id: target.id, before, after, childParents });
    }
    return;
  }
  if (drag) {
    const p = point(e);
    const small = Math.abs(p.x - drag.x1) < 3 && Math.abs(p.y - drag.y1) < 3;
    if (drag.node && !small) {
      const rec = { id: uuid(), type: drag.type, node: drag.node, attrs: {}, parentId: null };
      if (drag.type === 'line') {
        rec.x1 = drag.x1; rec.y1 = drag.y1; rec.x2 = p.x; rec.y2 = p.y;
      } else {
        rec.x = Math.min(drag.x1, p.x);
        rec.y = Math.min(drag.y1, p.y);
        rec.w = Math.abs(p.x - drag.x1);
        rec.h = Math.abs(p.y - drag.y1);
      }
      register(rec);
      // Containment для не-фреймов
      if (rec.type !== 'frame') {
        const f = frameContaining(rec);
        if (f) rec.parentId = f.id;
      }
      if (rec.type === 'frame') attachFrameTitleListener(rec);
      setFrameTarget(null);
      onElementCreated(rec);
      onToolUsed();
    } else if (drag.node) {
      drag.node.remove();
      setFrameTarget(null);
    }
    drag = null;
    return;
  }
  if (move) {
    const el = move.el;
    const wasInSelection = move.wasInSelection;
    const beforeMap = move.before;
    const p = point(e);
    const moved = Math.abs(p.x - move.startX) >= 3 || Math.abs(p.y - move.startY) >= 3;
    const wasGroupDrag = selectedIds.has(el.id) && selectedIds.size > 1;
    move = null;
    // Click без shift на элемент из multi-selection без реального drag → свернуть к одному.
    if (!moved && wasInSelection && selectedIds.size > 1) {
      selectShape(el);
      setFrameTarget(null);
      return;
    }
    // Containment пересчитывается только для одиночного drag.
    if (!wasGroupDrag && el.type !== 'frame') {
      const newParent = frameContaining(el);
      const newParentId = newParent ? newParent.id : null;
      if (newParentId !== el.parentId) {
        el.parentId = newParentId;
        onElementChanged(el);
      }
    }
    setFrameTarget(null);
    // Move op: only if real drag.
    if (moved && beforeMap) {
      const items = [];
      for (const [id, beforeGeo] of beforeMap.entries()) {
        const elx = elements.find(e => e.id === id);
        if (!elx) continue;
        const afterGeo = snapshotGeoLocal(elx);
        if (geoEqual(beforeGeo, afterGeo)) continue;
        items.push({ id, before: beforeGeo, after: afterGeo });
      }
      if (items.length) onMoveCommit(items);
    }
  }
}

function bboxFromTwoPoints(type, x1, y1, x2, y2) {
  if (type === 'line') {
    return {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    };
  }
  return {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
  };
}

function register(rec) {
  rec.node.classList.add('board-shape');
  rec.node.dataset.type = rec.type;
  rec.node.dataset.id = rec.id;
  if (rec.parentId === undefined) rec.parentId = null;
  elements.push(rec);
  return rec;
}

// Применить cosmetic-атрибуты (fill, stroke, opacity, color, font) к SVG-ноде из rec.attrs.
// Вызывается при загрузке из API и при изменении из контекст-меню.
// fill/stroke/color = null → 'none' / unset.
export function applyElementAttrs(rec) {
  if (!rec || !rec.node) return;
  const a = rec.attrs || {};
  if (rec.type === 'rect') {
    if (a.fill !== undefined) rec.node.setAttribute('fill', a.fill === null ? 'none' : a.fill);
    if (a.stroke !== undefined) rec.node.setAttribute('stroke', a.stroke === null ? 'none' : a.stroke);
    if (a.fillOpacity !== undefined) rec.node.setAttribute('fill-opacity', a.fillOpacity);
    if (a.strokeOpacity !== undefined) rec.node.setAttribute('stroke-opacity', a.strokeOpacity);
    return;
  }
  if (rec.type === 'text') {
    const input = rec.node.querySelector('input.board-text-input');
    if (!input) return;
    const desiredText = a.text == null ? '' : a.text;
    if (input.value !== desiredText) input.value = desiredText;
    if (a.color !== undefined) input.style.color = a.color === null ? '' : a.color;
    input.style.fontWeight = a.bold ? '700' : '';
    input.style.fontStyle = a.italic ? 'italic' : '';
    input.style.textDecoration = a.underline ? 'underline' : '';
    if (a.fontSize !== undefined) input.style.fontSize = a.fontSize + 'px';
    resizeTextWidth(rec);
    return;
  }
  if (rec.type === 'note') {
    const ta = rec.node.querySelector('textarea.board-note-textarea');
    if (!ta) return;
    const desiredText = a.text == null ? '' : a.text;
    if (ta.value !== desiredText) ta.value = desiredText;
    return;
  }
  if (rec.type === 'frame') {
    const input = rec.node.querySelector('input.board-frame-title');
    if (!input) return;
    const desiredTitle = a.title == null ? '' : a.title;
    if (input.value !== desiredTitle) input.value = desiredTitle;
    resizeFrameTitleWidth(rec);
  }
}

function createShape(type) {
  if (type === 'line') {
    const el = document.createElementNS(SVG_NS, 'line');
    el.setAttribute('stroke', '#212529');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    return el;
  }
  if (type === 'rect') {
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('fill', '#ffffff');
    el.setAttribute('stroke', '#212529');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('rx', '4');
    return el;
  }
  // frame: <g> с двумя rect — невидимый широкий stroke (hit-area) + видимая тонкая пунктирная линия
  // плюс foreignObject с input для названия (как в Miro, серый label над фреймом).
  const g = document.createElementNS(SVG_NS, 'g');
  const hit = document.createElementNS(SVG_NS, 'rect');
  hit.setAttribute('fill', 'none');
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '14');
  hit.setAttribute('pointer-events', 'stroke');
  const visible = document.createElementNS(SVG_NS, 'rect');
  visible.setAttribute('fill', 'none');
  visible.setAttribute('stroke', '#868e96');
  visible.setAttribute('stroke-width', '1.5');
  visible.setAttribute('stroke-dasharray', '6 4');
  visible.setAttribute('pointer-events', 'none');
  const titleFo = document.createElementNS(SVG_NS, 'foreignObject');
  titleFo.classList.add('board-frame-title-fo');
  titleFo.setAttribute('height', '20');
  titleFo.setAttribute('width', FRAME_TITLE_MIN_W); // обновится в resizeFrameTitleWidth
  const titleRow = document.createElement('div');
  titleRow.className = 'board-frame-title-row';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Без названия';
  titleInput.className = 'board-frame-title';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'board-frame-copy';
  copyBtn.title = 'Скопировать ссылку на фрейм';
  copyBtn.type = 'button';
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>';
  titleRow.appendChild(titleInput);
  titleRow.appendChild(copyBtn);
  titleFo.appendChild(titleRow);
  g.appendChild(hit);
  g.appendChild(visible);
  g.appendChild(titleFo);
  return g;
}

function attachFrameTitleListener(rec) {
  const input = rec.node.querySelector('input.board-frame-title');
  const copyBtn = rec.node.querySelector('button.board-frame-copy');
  if (!input) return;
  if (rec.attrs?.title) input.value = rec.attrs.title;
  resizeFrameTitleWidth(rec);
  input.addEventListener('input', () => {
    rec.attrs = rec.attrs || {};
    rec.attrs.title = input.value;
    resizeFrameTitleWidth(rec);
    onElementChanged(rec);
  });
  attachTextCommit(rec, input, 'title');
  if (copyBtn) {
    copyBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      onCopyLink(rec, copyBtn);
    });
    copyBtn.addEventListener('mousedown', e => e.stopPropagation());
  }
}

function setRectAttrs(node, x, y, w, h) {
  if (node.tagName === 'g') {
    for (const r of node.querySelectorAll('rect')) {
      r.setAttribute('x', x);
      r.setAttribute('y', y);
      r.setAttribute('width', w);
      r.setAttribute('height', h);
    }
    const fo = node.querySelector('foreignObject.board-frame-title-fo');
    if (fo) {
      fo.setAttribute('x', x);
      fo.setAttribute('y', y - 22);
      // width у title — динамически по содержимому, не привязан к ширине фрейма
    }
    return;
  }
  node.setAttribute('x', x);
  node.setAttribute('y', y);
  node.setAttribute('width', w);
  node.setAttribute('height', h);
}

function applyShape(node, type, x1, y1, x2, y2) {
  if (type === 'line') {
    node.setAttribute('x1', x1);
    node.setAttribute('y1', y1);
    node.setAttribute('x2', x2);
    node.setAttribute('y2', y2);
    return;
  }
  setRectAttrs(node, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
}

function moveBy(el, dx, dy) {
  if (el.type === 'line') {
    el.x1 += dx; el.y1 += dy;
    el.x2 += dx; el.y2 += dy;
    el.node.setAttribute('x1', el.x1);
    el.node.setAttribute('y1', el.y1);
    el.node.setAttribute('x2', el.x2);
    el.node.setAttribute('y2', el.y2);
    return;
  }
  el.x += dx; el.y += dy;
  if (el.type === 'rect') {
    el.node.setAttribute('x', el.x);
    el.node.setAttribute('y', el.y);
    return;
  }
  if (el.type === 'frame') {
    setRectAttrs(el.node, el.x, el.y, el.w, el.h);
    return;
  }
  if (el.type === 'text') {
    const fo = el.node.querySelector('foreignObject');
    const hit = el.node.querySelector('.board-edit-hit');
    const off = el.h / 2;
    if (fo) { fo.setAttribute('x', el.x); fo.setAttribute('y', el.y - off); }
    if (hit) { hit.setAttribute('x', el.x); hit.setAttribute('y', el.y - off); }
    return;
  }
  if (el.type === 'note') {
    const rectN = el.node.querySelector('rect.board-note-bg');
    const foN = el.node.querySelector('foreignObject');
    const hit = el.node.querySelector('.board-edit-hit');
    if (rectN) { rectN.setAttribute('x', el.x); rectN.setAttribute('y', el.y); }
    if (foN) { foN.setAttribute('x', el.x + 8); foN.setAttribute('y', el.y + 8); }
    if (hit) { hit.setAttribute('x', el.x); hit.setAttribute('y', el.y); }
  }
}

// Сменить selection. Принимает массив recs (или []).
// Single-select поведение — setSelection([rec]); deselect — setSelection([]).
export function setSelection(recs) {
  const newIds = new Set(recs.map(r => r.id));
  // Снять подсветку у тех, кого больше нет в selection.
  for (const id of selectedIds) {
    if (newIds.has(id)) continue;
    const r = elements.find(e => e.id === id);
    if (r && r.node) r.node.classList.remove('selected');
  }
  // Поставить подсветку новым.
  for (const r of recs) {
    if (r && r.node) r.node.classList.add('selected');
  }
  selectedIds = newIds;
  notifySelectionChanged();
}

function selectShape(el) {
  setSelection([el]);
}

export function deselect() {
  setSelection([]);
}

// Сообщить наружу про текущее selection. Контекст-меню/handles — только при size === 1.
function notifySelectionChanged() {
  if (selectedIds.size === 1) {
    const only = getOnlySelected();
    if (only.type === 'frame' || only.type === 'rect') showHandlesFor(only);
    else hideHandles();
    onSelectionChanged(only, bboxOf(only));
  } else {
    hideHandles();
    onSelectionChanged(null, null);
  }
}

// Удалить элемент локально (без сети). Снимает selection/edit/drag, если они на нём.
export function removeElement(id) {
  removeElements([id]);
}

// Удалить несколько элементов одним проходом — один notify в конце.
export function removeElements(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  let touchedSelection = false;
  const remaining = [];
  for (const rec of elements) {
    if (!idSet.has(rec.id)) {
      remaining.push(rec);
      continue;
    }
    if (selectedIds.has(rec.id)) {
      rec.node.classList.remove('selected');
      selectedIds.delete(rec.id);
      touchedSelection = true;
    }
    if (editing === rec) editing = null;
    if (move && move.el === rec) move = null;
    if (resize && resize.el === rec) resize = null;
    if (rec.node && rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
  }
  elements = remaining;
  if (touchedSelection) notifySelectionChanged();
}

// Применить текущие rec.x/y/w/h (или x1/y1/x2/y2 для line) к SVG-узлу.
function applyGeo(rec) {
  if (rec.type === 'line') {
    rec.node.setAttribute('x1', rec.x1);
    rec.node.setAttribute('y1', rec.y1);
    rec.node.setAttribute('x2', rec.x2);
    rec.node.setAttribute('y2', rec.y2);
    return;
  }
  if (rec.type === 'rect' || rec.type === 'frame') {
    setRectAttrs(rec.node, rec.x, rec.y, rec.w, rec.h);
    return;
  }
  if (rec.type === 'text') {
    const fo = rec.node.querySelector('foreignObject');
    const hit = rec.node.querySelector('.board-edit-hit');
    if (fo) { fo.setAttribute('x', rec.x); fo.setAttribute('y', rec.y - rec.h / 2); fo.setAttribute('width', rec.w); fo.setAttribute('height', rec.h); }
    if (hit) { hit.setAttribute('x', rec.x); hit.setAttribute('y', rec.y - rec.h / 2); hit.setAttribute('width', rec.w); hit.setAttribute('height', rec.h); }
    return;
  }
  if (rec.type === 'note') {
    const bg = rec.node.querySelector('rect.board-note-bg');
    const fo = rec.node.querySelector('foreignObject');
    const hit = rec.node.querySelector('.board-edit-hit');
    if (bg) { bg.setAttribute('x', rec.x); bg.setAttribute('y', rec.y); bg.setAttribute('width', rec.w); bg.setAttribute('height', rec.h); }
    if (fo) { fo.setAttribute('x', rec.x + 8); fo.setAttribute('y', rec.y + 8); fo.setAttribute('width', rec.w - 16); fo.setAttribute('height', rec.h - 16); }
    if (hit) { hit.setAttribute('x', rec.x); hit.setAttribute('y', rec.y); hit.setAttribute('width', rec.w); hit.setAttribute('height', rec.h); }
  }
}

// Снимок геометрии в API-формате (x,y,w,h + parentId). Для line: x,y = первая точка.
function snapshotGeoLocal(rec) {
  if (rec.type === 'line') {
    return { x: rec.x1, y: rec.y1, w: rec.x2 - rec.x1, h: rec.y2 - rec.y1, parentId: rec.parentId || null };
  }
  return { x: rec.x, y: rec.y, w: rec.w, h: rec.h, parentId: rec.parentId || null };
}

function geoEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && (a.parentId || null) === (b.parentId || null);
}

// Применить геометрию (из undo/redo) к существующему элементу: обновить rec, SVG, parentId, handles.
export function setElementGeo(id, geo) {
  const rec = elements.find(e => e.id === id);
  if (!rec) return;
  if (rec.type === 'line') {
    rec.x1 = geo.x; rec.y1 = geo.y;
    rec.x2 = geo.x + geo.w; rec.y2 = geo.y + geo.h;
  } else {
    rec.x = geo.x; rec.y = geo.y; rec.w = geo.w; rec.h = geo.h;
  }
  rec.parentId = geo.parentId || null;
  applyGeo(rec);
  if (rec.type === 'text') resizeTextWidth(rec);
  if (getOnlySelected() === rec) {
    if (rec.type === 'frame' || rec.type === 'rect') updateHandles(rec);
    onSelectionChanged(rec, bboxOf(rec));
  }
}

// Изменить parent_id элемента (для undo/redo resize-а фрейма с reparenting'ом детей).
export function setElementParent(id, parentId) {
  const rec = elements.find(e => e.id === id);
  if (!rec) return;
  rec.parentId = parentId || null;
}

export function getElementById(id) {
  return elements.find(e => e.id === id) || null;
}

// Подключить focus/blur tracking к input/textarea чтобы push'ить attr-commit (text/title) per blur.
// `key` — какой attr меняется ('text' для text/note, 'title' для frame).
function attachTextCommit(rec, input, key) {
  let savedValue = null;
  input.addEventListener('focus', () => { savedValue = input.value; });
  input.addEventListener('blur', () => {
    if (savedValue === null) return;
    if (savedValue !== input.value) {
      onTextCommit(rec, key, savedValue, input.value);
    }
    savedValue = null;
  });
}

function collectMoveTargets(shape, wasInSelection) {
  const ids = new Set([shape.id]);
  if (wasInSelection && selectedIds.size > 1) {
    for (const sel of getAllSelected()) {
      ids.add(sel.id);
      if (sel.type === 'frame') for (const c of childrenOf(sel.id)) ids.add(c.id);
    }
  } else if (shape.type === 'frame') {
    for (const c of childrenOf(shape.id)) ids.add(c.id);
  }
  return ids;
}

function recomputeChildrenAfterResize(frame) {
  const fb = bboxOf(frame);
  for (const el of elements) {
    if (el === frame) continue;
    if (el.type === 'frame') continue;
    const eb = bboxOf(el);
    const fullyInside =
      eb.x >= fb.x && eb.y >= fb.y &&
      eb.x + eb.w <= fb.x + fb.w &&
      eb.y + eb.h <= fb.y + fb.h;
    if (el.parentId === frame.id) {
      if (!fullyInside) {
        el.parentId = null;
        onElementChanged(el);
      }
    } else if (el.parentId == null) {
      if (fullyInside) {
        el.parentId = frame.id;
        onElementChanged(el);
      }
    }
    // если el.parentId — другой фрейм, не трогаем
  }
}

// opts: { id?, text?, focus?, parentId? }
function placeText(x, y, opts = {}) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('board-shape');
  g.dataset.type = 'text';

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', x);
  fo.setAttribute('y', y - 12);
  fo.setAttribute('width', TEXT_MIN_W);
  fo.setAttribute('height', TEXT_H);
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '';
  input.className = 'board-text-input';
  if (opts.text) input.value = opts.text;
  fo.appendChild(input);

  const hit = document.createElementNS(SVG_NS, 'rect');
  hit.classList.add('board-edit-hit');
  hit.setAttribute('x', x);
  hit.setAttribute('y', y - 12);
  hit.setAttribute('width', TEXT_MIN_W);
  hit.setAttribute('height', TEXT_H);

  g.appendChild(fo);
  g.appendChild(hit);
  svg.appendChild(g);

  const rec = {
    id: opts.id || uuid(),
    type: 'text',
    node: g,
    x, y,
    w: TEXT_MIN_W, h: TEXT_H,
    attrs: { text: opts.text || '' },
    parentId: opts.parentId || null,
  };
  g.dataset.id = rec.id;
  elements.push(rec);
  resizeTextWidth(rec); // подгоняем ширину под initial value

  input.addEventListener('input', () => {
    rec.attrs.text = input.value;
    resizeTextWidth(rec);
    onElementChanged(rec);
  });
  attachTextCommit(rec, input, 'text');
  g.addEventListener('dblclick', e => { enterEdit(rec); e.stopPropagation(); });

  if (!opts.id) {
    const f = frameContaining(rec);
    if (f) rec.parentId = f.id;
    onElementCreated(rec);
    enterEdit(rec);
  }
  return rec;
}

function placeNote(x, y, opts = {}) {
  const W = opts.w || 180, H = opts.h || 140;
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('board-shape');
  g.dataset.type = 'note';

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.classList.add('board-note-bg');
  bg.setAttribute('x', x);
  bg.setAttribute('y', y);
  bg.setAttribute('width', W);
  bg.setAttribute('height', H);
  bg.setAttribute('fill', '#fff8c6');
  bg.setAttribute('stroke', '#f1c40f');
  bg.setAttribute('stroke-width', '1');
  bg.setAttribute('rx', '2');
  g.appendChild(bg);

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', x + 8);
  fo.setAttribute('y', y + 8);
  fo.setAttribute('width', W - 16);
  fo.setAttribute('height', H - 16);
  const ta = document.createElement('textarea');
  ta.placeholder = 'Заметка…';
  ta.className = 'board-note-textarea';
  if (opts.text) ta.value = opts.text;
  fo.appendChild(ta);
  g.appendChild(fo);

  const hit = document.createElementNS(SVG_NS, 'rect');
  hit.classList.add('board-edit-hit');
  hit.setAttribute('x', x);
  hit.setAttribute('y', y);
  hit.setAttribute('width', W);
  hit.setAttribute('height', H);
  g.appendChild(hit);

  svg.appendChild(g);

  const rec = {
    id: opts.id || uuid(),
    type: 'note',
    node: g,
    x, y, w: W, h: H,
    attrs: { text: opts.text || '' },
    parentId: opts.parentId || null,
  };
  g.dataset.id = rec.id;
  elements.push(rec);

  ta.addEventListener('input', () => {
    rec.attrs.text = ta.value;
    onElementChanged(rec);
  });
  attachTextCommit(rec, ta, 'text');
  g.addEventListener('dblclick', e => { enterEdit(rec); e.stopPropagation(); });

  if (!opts.id) {
    const f = frameContaining(rec);
    if (f) rec.parentId = f.id;
    onElementCreated(rec);
    enterEdit(rec);
  }
  return rec;
}
