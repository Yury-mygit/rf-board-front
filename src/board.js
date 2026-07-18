// Board (whiteboard) — рисование и манипуляция примитивами на SVG.
// Состояние держится здесь; внешний код (main.js) синкает с backend через callbacks.
//
// Геометрия в API: x, y — точка-якорь; w, h — размер.
// Для line: (x, y) = первая точка, (x+w, y+h) = вторая (w/h могут быть отрицательными).
// parentId: только для фреймов (frame containment, как в Miro).

import {
  BPMN_SHAPE_TYPES, BPMN_DEFAULTS, isBpmnShape, isBpmnType,
  ensureBpmnDefs, createBpmnShape, applyBpmnShapeGeo, applyBpmnShapeAttrs,
  createBpmnFlow, updateBpmnFlow, normalizeBpmnGeo,
} from './bpmn.js';
import {
  C4_DEFAULTS, isC4Shape,
  ensureC4Defs, createC4Shape, applyC4ShapeGeo, applyC4ShapeAttrs,
  createC4Relationship, updateC4Relationship, normalizeC4Geo,
} from './c4.js';
import { assetUrl, mediaUpload } from './media.js';

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
// BRD-7: long-press на shape → override select/drag, старт rubber.
let longPressTimer = null;
let longPressAnchor = null; // { p, e-info для startRubber }
const LONG_PRESS_MS = 1000;
const LONG_PRESS_MOVE_PX = 4;
let editing = null;  // text/note в режиме редактирования (input доступен)
let frameTarget = null; // фрейм-цель при drag (для подсветки)
let flowStart = null; // первый shape выбран для создания bpmn_flow
let c4RelStart = null; // первый shape выбран для создания c4_relationship
let handlesG = null; // <g> с 8 resize-handles, всегда поверх
// BRD-16: три семантических слоя в svg. Порядок фиксирован: bg → content → overlay.
// Хендлы, rubber-band, drag-ghost, frame-target-подсветка живут в layerOverlay
// постоянно (не переносим в конец на каждом selectShape). Grid в layerBg.
let layerBg = null;
let layerContent = null;
let layerOverlay = null;
let gridBgRect = null; // фоновый rect под всеми элементами с fill=url(#board-grid)
let gridPattern = null; // <pattern>, шаг пересчитывается в applyViewBox
let gridLine = null;    // <path> внутри pattern: две линии (верх и лево ячейки)

const GRID_BASE_STEP = 50;     // world-units на zoom=1
const GRID_MIN_SCREEN_PX = 18; // ниже — шаг ×5 (более крупная LOD)
const GRID_MAX_SCREEN_PX = 90; // выше — шаг ÷5 (более мелкая LOD)
const GRID_STROKE_SCREEN_PX = 1; // толщина линий в screen-px

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
const NOTE_MIN = 60;
const NOTE_MIN_HARD = 24;
const NOTE_MIN_H = 24;
const TEXT_MIN_W = 40;     // ~3 символа
const TEXT_H = 32;
const TEXT_FONT = '14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FRAME_TITLE_BASE_SIZE = 14;   // base font-size, «уровень 14»
const FRAME_TITLE_MIN_SIZE = 10;    // читаемый минимум при shrink'е
const FRAME_TITLE_MIN_CHARS = 5;    // hide-порог: если 5 M-символов не влезают
const FRAME_TITLE_COPY_BTN_W = 22;  // ширина кнопки copy + gap
const FRAME_TITLE_PADDING = 8;      // side padding в fo

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

function _frameTitleFont(size) {
  return `${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

// Подгоняем название фрейма: font-size уменьшается если полный текст не
// влезает в ширину фрейма (fo НЕ шире фрейма); скрываем, если фрейм
// слишком узкий чтобы вместить хотя бы FRAME_TITLE_MIN_CHARS символов
// «M» при базовом кегле. Название не может быть шире самого фрейма.
// Название фрейма — zoom-invariant target 14px **на экране** (не в
// board-координатах). При zoom-out font в board-coords растёт, чтобы
// отрисованный размер оставался ~14 screen px. Hide-порог и shrink —
// в screen-space (независимо от zoom).
function fitFrameTitle(rec) {
  const fo = rec.node.querySelector('foreignObject.board-frame-title-fo');
  const input = rec.node.querySelector('input.board-frame-title');
  if (!fo || !input) return;

  const zoom = viewport.zoom || 1;
  const frameX = rec.x != null ? rec.x : parseFloat(fo.getAttribute('x') || 0);
  const frameY = rec.y != null ? rec.y : parseFloat(fo.getAttribute('y') || 0);
  const frameW = Math.max(0, rec.w || 0);
  const frameScreenW = frameW * zoom;
  const text = input.value || input.placeholder || '';
  const baseFont = _frameTitleFont(FRAME_TITLE_BASE_SIZE);

  // Hide-порог в screen-space: если 5 «M» + copy-btn + padding не влезают
  // в ширину фрейма на экране — скрываем.
  const minCharsW = measureWidth('M'.repeat(FRAME_TITLE_MIN_CHARS), baseFont);
  const minFrameScreenW = minCharsW + FRAME_TITLE_COPY_BTN_W + FRAME_TITLE_PADDING;
  if (frameScreenW < minFrameScreenW) {
    fo.style.display = 'none';
    return;
  }
  fo.style.display = '';

  // Screen font-size: базовый 14, сжимаем если текст не влезает.
  const availTextScreenW = Math.max(1, frameScreenW - FRAME_TITLE_COPY_BTN_W - FRAME_TITLE_PADDING);
  const textScreenW = measureWidth(text, baseFont) || 1;
  let screenFontSize = FRAME_TITLE_BASE_SIZE;
  if (textScreenW > availTextScreenW) {
    screenFontSize = Math.max(
      FRAME_TITLE_MIN_SIZE,
      Math.floor(FRAME_TITLE_BASE_SIZE * availTextScreenW / textScreenW),
    );
  }

  // Board font = screen / zoom (компенсируем camera scale).
  const boardFontSize = screenFontSize / zoom;
  input.style.fontSize = `${boardFontSize}px`;

  // FO в board-coords. Ширина ≤ frameW (заголовок не шире фрейма).
  // Высота такова, чтобы screen-высота была ≈ screenFontSize + 8.
  const titleScreenH = Math.max(20, screenFontSize + 8);
  const titleH = titleScreenH / zoom;
  fo.setAttribute('x', frameX);
  fo.setAttribute('y', frameY - titleH - 2 / zoom);
  fo.setAttribute('width', frameW);
  fo.setAttribute('height', titleH);
}

// Re-fit всех frame titles — вызывается при zoom-changed из applyViewBox.
function refitAllFrameTitles() {
  for (const rec of elements) {
    if (rec.type === 'frame') fitFrameTitle(rec);
  }
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

  // BRD-16: layer groups создаются ПЕРВЫМИ, порядок фиксирует z-order (bg < content < overlay).
  layerBg = document.createElementNS(SVG_NS, 'g');
  layerBg.classList.add('layer-bg');
  svg.appendChild(layerBg);
  layerContent = document.createElementNS(SVG_NS, 'g');
  layerContent.classList.add('layer-content');
  svg.appendChild(layerContent);
  layerOverlay = document.createElementNS(SVG_NS, 'g');
  layerOverlay.classList.add('layer-overlay');
  svg.appendChild(layerOverlay);

  installGridBackground();
  ensureBpmnDefs(svg);
  ensureC4Defs(svg);
  ensureBoardArrowDefs(svg);

  handlesG = createHandles();
  layerOverlay.appendChild(handlesG);

  applyViewBox();
  const ro = new ResizeObserver(() => applyViewBox());
  ro.observe(container);

  svg.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('touchstart', onTouchStart, { passive: false });
  svg.addEventListener('touchmove', onTouchMove, { passive: false });
  svg.addEventListener('touchend', onTouchEnd);
  svg.addEventListener('touchcancel', onTouchEnd);
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
  updateGridForViewport(vw, vh);
  refreshHandlesIfVisible();
  refitAllFrameTitles();
  onViewportChanged({ ...viewport });
}

// Generic arrow marker для `line.attrs.arrow`. Отдельный от bpmn-arrow /
// c4-arrow, чтобы цвет/геометрия trade-off не таскали друг друга.
function ensureBoardArrowDefs(svg) {
  if (svg.querySelector('defs marker#board-arrow')) return;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'board-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('orient', 'auto-start-reverse');
  marker.setAttribute('markerUnits', 'strokeWidth');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M0 0 L10 5 L0 10 z');
  path.setAttribute('fill', '#212529');
  marker.appendChild(path);
  defs.appendChild(marker);
}

// Фон-сетка как в Miro: точечный pattern, шаг переключается на ×5/÷5 при пересечении
// порогов screen-px, чтобы ячейки не сливались на zoom-out и не разъезжались на zoom-in.
function installGridBackground() {
  const defs = document.createElementNS(SVG_NS, 'defs');
  gridPattern = document.createElementNS(SVG_NS, 'pattern');
  gridPattern.setAttribute('id', 'board-grid');
  gridPattern.setAttribute('patternUnits', 'userSpaceOnUse');
  gridPattern.setAttribute('x', '0');
  gridPattern.setAttribute('y', '0');
  gridLine = document.createElementNS(SVG_NS, 'path');
  gridLine.setAttribute('fill', 'none');
  gridLine.setAttribute('stroke', '#dfe2e7');
  gridPattern.appendChild(gridLine);
  defs.appendChild(gridPattern);
  svg.appendChild(defs);

  gridBgRect = document.createElementNS(SVG_NS, 'rect');
  gridBgRect.classList.add('board-grid-bg');
  gridBgRect.setAttribute('fill', 'url(#board-grid)');
  // BRD-16: grid — в layerBg, всегда под содержимым доски.
  layerBg.appendChild(gridBgRect);
}

function updateGridForViewport(vw, vh) {
  if (!gridBgRect || !gridPattern || !gridLine) return;
  let step = GRID_BASE_STEP;
  while (step * viewport.zoom < GRID_MIN_SCREEN_PX) step *= 5;
  while (step * viewport.zoom > GRID_MAX_SCREEN_PX) step /= 5;
  gridPattern.setAttribute('width', step);
  gridPattern.setAttribute('height', step);
  gridLine.setAttribute('d', `M 0 0 H ${step} M 0 0 V ${step}`);
  gridLine.setAttribute('stroke-width', GRID_STROKE_SCREEN_PX / viewport.zoom);
  // BG rect — на 1 шаг шире viewport по краям, чтобы при субпиксельных дрожаниях pan
  // не было видно границы прямоугольника. Округление вниз до сетки — точки не "плывут".
  const padX = step, padY = step;
  const bx = Math.floor((viewport.vx - padX) / step) * step;
  const by = Math.floor((viewport.vy - padY) / step) * step;
  gridBgRect.setAttribute('x', bx);
  gridBgRect.setAttribute('y', by);
  gridBgRect.setAttribute('width', vw + padX * 4);
  gridBgRect.setAttribute('height', vh + padY * 4);
}

export function getZoom() { return viewport.zoom; }
export function getViewport() { return { ...viewport }; }
export function setViewport(v) {
  if (typeof v.vx === 'number') viewport.vx = v.vx;
  if (typeof v.vy === 'number') viewport.vy = v.vy;
  if (typeof v.zoom === 'number') viewport.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.zoom));
  applyViewBox();
}

// Сдвиг камеры на (dxPx, dyPx) в экранных пикселях. Используется
// клавиатурным pan'ом — экранные шаги дают одинаковое ощущение при
// любом zoom.
export function panViewportByScreen(dxPx, dyPx) {
  if (!svg || !viewport.zoom) return;
  viewport.vx += dxPx / viewport.zoom;
  viewport.vy += dyPx / viewport.zoom;
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

// Wheel — всегда zoom вокруг курсора (Miro/Figma-стиль). Pan делается
// средней кнопкой мыши, Space+drag или двумя пальцами на трекпаде.
// Pinch-зум на трекпаде браузер шлёт как wheel с ctrlKey=true — попадает
// в ту же ветку.
function onWheel(e) {
  e.preventDefault();
  setZoomAt(e.clientX, e.clientY, viewport.zoom * Math.exp(-e.deltaY / 500));
}

// Два пальца на тач-экране: pan по центру + pinch-zoom. Точка под начальным
// центром остаётся под текущим центром, расстояние между пальцами регулирует zoom.
let touchGesture = null;

function touchCenter(touches) {
  return [(touches[0].clientX + touches[1].clientX) / 2, (touches[0].clientY + touches[1].clientY) / 2];
}
function touchDist(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}
function cancelMouseInteractions() {
  if (drag && drag.node) drag.node.remove();
  if (rubber && rubber.node) rubber.node.remove();
  drag = rubber = move = resize = pan = null;
  setFrameTarget(null);
  refreshCursor();
}
function onTouchStart(e) {
  if (e.touches.length < 2) return;
  e.preventDefault();
  cancelMouseInteractions();
  const [cx, cy] = touchCenter(e.touches);
  const anchor = screenToWorld(cx, cy);
  touchGesture = {
    startZoom: viewport.zoom,
    startDist: touchDist(e.touches) || 1,
    anchorWx: anchor.x,
    anchorWy: anchor.y,
  };
}
function onTouchMove(e) {
  if (!touchGesture || e.touches.length < 2) return;
  e.preventDefault();
  const [cx, cy] = touchCenter(e.touches);
  const scale = touchDist(e.touches) / touchGesture.startDist;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, touchGesture.startZoom * scale));
  viewport.zoom = newZoom;
  const rect = svg.getBoundingClientRect();
  viewport.vx = touchGesture.anchorWx - (cx - rect.left) / newZoom;
  viewport.vy = touchGesture.anchorWy - (cy - rect.top) / newZoom;
  applyViewBox();
}
function onTouchEnd(e) {
  if (!touchGesture) return;
  if (e.touches.length >= 2) return;
  touchGesture = null;
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
  // BRD-16: handlesG живёт в layerOverlay постоянно, re-append не нужен.
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
  if (sel && (sel.type === 'frame' || sel.type === 'rect' || sel.type === 'oval' || sel.type === 'image' || sel.type === 'note' || sel.type === 'text' || isBpmnShape(sel.type) || isC4Shape(sel.type))) updateHandles(sel);
}

export function setBoardCursor(tool) {
  refreshCursor();
}

export function clearBoard() {
  if (!layerContent) return;
  // BRD-16: элементы досок живут в layerContent; layerBg (grid) и
  // layerOverlay (handles/rubber/ghost) не трогаем.
  for (const node of [...layerContent.querySelectorAll('[data-id]')]) {
    node.remove();
  }
  for (const ph of [...layerContent.querySelectorAll('[data-image-placeholder]')]) {
    ph.remove();
  }
  if (handlesG) hideHandles();
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

// Snapshot всех текущих элементов (state). Для main.js — z-order min/max.
export function getAllElements() { return elements; }

// BRD-16: DOM-reorder элемента в пределах layer-content'а.
// Front → в конец слоя (визуально сверху), Back → в начало (визуально снизу,
// но всё ещё поверх layer-bg с grid'ом). Используется main.js для z-order UI.
export function bringNodeToFrontInLayer(node) {
  if (!node || !layerContent) return;
  layerContent.appendChild(node);
}
export function bringNodeToBackInLayer(node) {
  if (!node || !layerContent) return;
  if (layerContent.firstChild) layerContent.insertBefore(node, layerContent.firstChild);
  else layerContent.appendChild(node);
}

// BRD-22: переставить rec.node в правильную позицию внутри layerContent на
// основании rec.z_index. Точка вставки — перед первым sibling с большим
// z_index; если таких нет — append в конец. Idempotent: если позиция уже
// правильная, DOM не трогается (защита от лишних reflow при self-echo SSE).
function _placeNodeByZIndex(rec) {
  if (!rec || !rec.node || !layerContent) return;
  if (rec.node.parentNode !== layerContent) return;
  const myZ = rec.z_index || 0;
  const myId = rec.id;
  let insertBeforeNode = null;
  let minGreaterZ = Infinity;
  for (const el of elements) {
    if (el.id === myId) continue;
    if (!el.node || el.node.parentNode !== layerContent) continue;
    const z = el.z_index || 0;
    if (z > myZ && z < minGreaterZ) {
      minGreaterZ = z;
      insertBeforeNode = el.node;
    }
  }
  if (insertBeforeNode) {
    if (rec.node.nextSibling !== insertBeforeNode) {
      layerContent.insertBefore(rec.node, insertBeforeNode);
    }
  } else {
    if (layerContent.lastChild !== rec.node) {
      layerContent.appendChild(rec.node);
    }
  }
}

// Удалить элемент по id из state и DOM (карта #36 live updates).
export function removeFromApi(id) {
  const idx = elements.findIndex(e => e.id === id);
  if (idx < 0) return false;
  const rec = elements[idx];
  if (rec.node && rec.node.parentNode) rec.node.parentNode.removeChild(rec.node);
  if (rec._placeholder && rec._placeholder.parentNode) rec._placeholder.parentNode.removeChild(rec._placeholder);
  elements.splice(idx, 1);
  selectedIds.delete(id);
  return true;
}

// Upsert: для существующих элементов делаем in-place patch с CSS-transition
// (через class .live-transition), новые рендерим как обычно. In-place
// сохраняет DOM-ноду — браузер анимирует x/y/width/height attributes.
export function upsertFromApi(e) {
  if (!e || !e.id) return;
  const existing = elements.find(el => el.id === e.id);
  if (!existing) {
    renderFromApi(e);
    // BRD-22: гарантируем правильную DOM-позицию новосозданного узла в
    // layerContent по его z_index (SSE может доставить create для элемента
    // с z_index в середине стека, не обязательно самый верхний).
    const rec = elements.find(el => el.id === e.id);
    if (rec) _placeNodeByZIndex(rec);
    return;
  }
  _patchInPlace(existing, e);
}

function _patchInPlace(rec, e) {
  const attrs = e.attrs || {};
  rec.attrs = attrs;
  rec.parentId = e.parentId || null;
  // BRD-22: если z_index изменился — переставить DOM-узел в правильную
  // позицию внутри layerContent. Ранее только state обновлялся, DOM
  // оставался в старой позиции (гэп проявлялся у второго клиента при
  // z-order изменениях от первого).
  if (e.zIndex !== undefined) {
    const zChanged = rec.z_index !== e.zIndex;
    rec.z_index = e.zIndex;
    if (zChanged) _placeNodeByZIndex(rec);
  }
  // Cascade: если backend сказал что frame двинулся на (cascade_dx, cascade_dy),
  // фронт translate'ит всех потомков. НО: если frame у нас уже на
  // (e.x, e.y) — значит юзер сам drag'ом двинул и frame, и детей
  // (drag-move в move-handler двигает children тоже), и cascade приведёт
  // к УДВОЕНИЮ. Echo-suppression: применяем cascade только если frame
  // ещё не на новых координатах.
  if ((e._cascadeDx || e._cascadeDy) && rec.type === 'frame') {
    const frameDx = e.x - rec.x;
    const frameDy = e.y - rec.y;
    if (Math.abs(frameDx) > 0.5 || Math.abs(frameDy) > 0.5) {
      _cascadeMoveChildren(rec.id, e._cascadeDx || 0, e._cascadeDy || 0);
    }
  }
  // Универсальный подход: сдвиг через (dx, dy) translate всех внутренних
  // координатных атрибутов. Работает для frame/rect/text/note/image/line —
  // не нужно знать внутреннюю структуру с offset'ами.
  const oldX = rec.type === 'line' ? Math.min(rec.x1, rec.x2) : rec.x;
  const oldY = rec.type === 'line' ? Math.min(rec.y1, rec.y2) : rec.y;
  const newX = rec.type === 'line' ? e.x : e.x;
  const newY = rec.type === 'line' ? e.y : e.y;
  const dx = newX - oldX;
  const dy = newY - oldY;
  if (rec.type === 'line') {
    rec.x1 = e.x; rec.y1 = e.y; rec.x2 = e.x + e.w; rec.y2 = e.y + e.h;
  } else {
    rec.x = e.x; rec.y = e.y;
    if (e.w !== undefined) rec.w = e.w;
    if (e.h !== undefined) rec.h = e.h;
  }
  _animateNode(rec.node, () => {
    if (dx || dy) _translateNode(rec.node, dx, dy);
    // отдельно width/height для frame/rect/note — могут меняться без move
    if (rec.type === 'rect' || rec.type === 'oval' || rec.type === 'frame' || rec.type === 'note') {
      // setRectAttrs принимает абсолютные x/y/w/h — для resize.
      // При только move (dx,dy) — уже сделано translate'ом, w/h не менялись.
      // setRectAttrs мы вызываем ТОЛЬКО если w/h изменились.
      // Здесь проверка пропущена ради простоты: setRectAttrs повторно
      // выставит x/y (то же значение, что и после translate) — idempotent.
      setRectAttrs(rec.node, rec.x, rec.y, rec.w, rec.h);
    } else if (rec.type === 'image') {
      rec.node.setAttribute('width', rec.w);
      rec.node.setAttribute('height', rec.h);
    }
  });
  applyElementAttrs(rec);
  // BRD-20 hotfix убран — BRD-21 δ' переехал refreshHandlesIfVisible внутрь
  // _animateNode, где handles получают .live-transition и анимируются синхронно.
}

// Рекурсивно двигает всех потомков frame'а на (dx, dy) — и DOM, и state.
// Все mutations в одном tick'е → CSS-transition стартует синхронно у всех.
// applyGeo диспатчит по типу — каждый shape знает как себя перерисовать
// корректно (sub-элементы c4_person/bpmn_event через applyC4ShapeGeo /
// applyBpmnShapeGeo, ре-routing relationships через recomputeFlows
// внутри applyGeo). Старый `_translateNode` не покрывает <circle>/<path>.
function _cascadeMoveChildren(frameId, dx, dy) {
  for (const el of elements) {
    if (el.parentId !== frameId) continue;
    if (el.type === 'line') {
      el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy;
    } else {
      el.x += dx; el.y += dy;
    }
    _animateNode(el.node, () => applyGeo(el));
    if (el.type === 'frame') _cascadeMoveChildren(el.id, dx, dy);
  }
}

// Сдвигает все координатные атрибуты внутри ноды на (dx, dy). Работает
// для любой SVG-структуры: проходит по <rect>, <image>, <foreignObject>,
// <text>, <line>, плюс сам root-узел (если у него есть x/y).
function _translateNode(node, dx, dy) {
  if (!node) return;
  const all = [node, ...node.querySelectorAll('rect, image, foreignObject, text, line')];
  for (const el of all) {
    if (el.hasAttribute && el.hasAttribute('x')) {
      el.setAttribute('x', parseFloat(el.getAttribute('x')) + dx);
    }
    if (el.hasAttribute && el.hasAttribute('y')) {
      el.setAttribute('y', parseFloat(el.getAttribute('y')) + dy);
    }
    if (el.hasAttribute && el.hasAttribute('x1')) {
      el.setAttribute('x1', parseFloat(el.getAttribute('x1')) + dx);
      el.setAttribute('y1', parseFloat(el.getAttribute('y1')) + dy);
      el.setAttribute('x2', parseFloat(el.getAttribute('x2')) + dx);
      el.setAttribute('y2', parseFloat(el.getAttribute('y2')) + dy);
    }
  }
}

// Добавляет класс .live-transition на 320ms — CSS-анимация x/y/width/height.
// Без этого класса (например drag-move) переходы выключены.
// BRD-21 (δ'): если handles видны — они тоже получают .live-transition и
// обновляются immediately, анимируясь ту же 280ms transition, что и shape.
// Handles остаются в глобальном handlesG (Miro invariant «handles always on top»).
function _animateNode(node, mutate) {
  if (!node) { mutate(); return; }
  node.classList.add('live-transition');
  // Дочерние ноды (group → rect, foreignObject) тоже должны анимироваться.
  node.querySelectorAll && node.querySelectorAll('rect, foreignObject, image').forEach(n => n.classList.add('live-transition'));
  const handlesVisible = handlesG && handlesG.style.display !== 'none';
  if (handlesVisible) {
    handlesG.querySelectorAll('.resize-handle').forEach(n => n.classList.add('live-transition'));
  }
  mutate();
  // Handles rects обновятся сразу на новые x/y/w/h — анимируются вместе с shape.
  if (handlesVisible) refreshHandlesIfVisible();
  setTimeout(() => {
    node.classList.remove('live-transition');
    node.querySelectorAll && node.querySelectorAll('rect, foreignObject, image').forEach(n => n.classList.remove('live-transition'));
    if (handlesG) {
      handlesG.querySelectorAll('.resize-handle').forEach(n => n.classList.remove('live-transition'));
    }
  }, 320);
}

// Добавить элемент из API-формата (используется при redo create / undo delete).
export function addFromApi(e) {
  renderFromApi(e);
}

function renderFromApi(e) {
  _renderFromApiInner(e);
  // BRD-22: устанавливаем rec.z_index сразу после render, чтобы дальнейшие
  // _placeNodeByZIndex-вызовы и SSE-patch'и работали от корректного oldZ.
  // Initial loadBoard уже даёт правильный DOM-порядок (backend ORDER BY
  // z_index ASC + sequential appendChild), но state без этой строки хранит
  // z_index=undefined до первого patch'а.
  if (e.zIndex !== undefined) {
    const rec = elements.find(el => el.id === e.id);
    if (rec) rec.z_index = e.zIndex;
  }
}

function _renderFromApiInner(e) {
  const attrs = e.attrs || {};
  const parentId = e.parentId || null;
  if (e.type === 'rect' || e.type === 'oval' || e.type === 'frame') {
    const node = createShape(e.type);
    setRectAttrs(node, e.x, e.y, e.w, e.h);
    layerContent.appendChild(node);
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
    layerContent.appendChild(node);
    const rec = register({
      id: e.id, type: 'line', node,
      x1: e.x, y1: e.y, x2: e.x + e.w, y2: e.y + e.h,
      attrs, parentId,
    });
    applyElementAttrs(rec);
    return;
  }
  if (e.type === 'text') {
    // Card #134: wrap-mode прокидываем при создании, чтобы placeText
    // сразу собрал textarea + top-anchored fo с правильной геометрией.
    const wrap = !!(attrs && attrs.wrap);
    const rec = placeText(e.x, e.y, {
      id: e.id,
      text: attrs.text || '',
      focus: false,
      parentId,
      wrap,
      w: wrap ? e.w : undefined,
      h: wrap ? e.h : undefined,
    });
    rec.attrs = attrs;
    applyElementAttrs(rec);
    if (wrap) recomputeTextWrapHeight(rec);
    return;
  }
  if (e.type === 'note') {
    const rec = placeNote(e.x, e.y, { id: e.id, w: e.w, h: e.h, text: attrs.text || '', focus: false, parentId, autoFit: attrs.autoFit });
    rec.attrs = { autoFit: true, ...attrs };
    applyElementAttrs(rec);
    return;
  }
  if (e.type === 'image') {
    const placeholder = createImagePlaceholder(e.x, e.y, e.w, e.h);
    layerContent.appendChild(placeholder);
    const node = document.createElementNS(SVG_NS, 'image');
    node.classList.add('board-shape');
    node.dataset.type = 'image';
    node.setAttribute('x', e.x);
    node.setAttribute('y', e.y);
    node.setAttribute('width', e.w);
    node.setAttribute('height', e.h);
    const rec = register({ id: e.id, type: 'image', node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId });
    rec._placeholder = placeholder;
    node.addEventListener('load', () => removeImagePlaceholder(rec), { once: true });
    node.addEventListener('error', () => removeImagePlaceholder(rec), { once: true });
    layerContent.appendChild(node);
    applyElementAttrs(rec);
    return;
  }
  if (isBpmnShape(e.type)) {
    const node = createBpmnShape(e.type, attrs);
    layerContent.appendChild(node);
    const rec = register({ id: e.id, type: e.type, node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId });
    applyBpmnShapeGeo(node, e.type, e.x, e.y, e.w, e.h);
    applyBpmnShapeAttrs(node, e.type, attrs);
    return;
  }
  if (e.type === 'bpmn_flow') {
    const node = createBpmnFlow();
    layerContent.appendChild(node);
    const rec = register({ id: e.id, type: 'bpmn_flow', node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId: null });
    // source/target ищем в loaded elements; если не нашли — рисуем по x/y/w/h.
    const s = attrs.sourceId ? elements.find(el => el.id === attrs.sourceId) : null;
    const t = attrs.targetId ? elements.find(el => el.id === attrs.targetId) : null;
    updateBpmnFlow(rec, s, t);
    return;
  }
  if (isC4Shape(e.type)) {
    const node = createC4Shape(e.type);
    layerContent.appendChild(node);
    const rec = register({ id: e.id, type: e.type, node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId });
    applyC4ShapeGeo(node, e.type, e.x, e.y, e.w, e.h);
    applyC4ShapeAttrs(node, e.type, attrs);
    return;
  }
  if (e.type === 'c4_relationship') {
    const node = createC4Relationship();
    layerContent.appendChild(node);
    const rec = register({ id: e.id, type: 'c4_relationship', node, x: e.x, y: e.y, w: e.w, h: e.h, attrs, parentId: null });
    const s = attrs.sourceId ? elements.find(el => el.id === attrs.sourceId) : null;
    const t = attrs.targetId ? elements.find(el => el.id === attrs.targetId) : null;
    updateC4Relationship(rec, s, t);
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
  // BRD-5: заблокированный элемент не двигается drag'ом.
  if (el.attrs && el.attrs.locked) return false;
  return el.type === 'line' || el.type === 'rect' || el.type === 'oval' || el.type === 'frame'
      || el.type === 'text' || el.type === 'note' || el.type === 'image'
      || isBpmnShape(el.type) || isC4Shape(el.type);
}

// BRD-5: single-place check «этот элемент заблокирован».
export function isLocked(el) {
  return !!(el && el.attrs && el.attrs.locked);
}

// Все edges (bpmn_flow + c4_relationship), у которых source или target —
// заданный id. Используется для пересчёта path при move/resize концов.
function isEdgeType(t) { return t === 'bpmn_flow' || t === 'c4_relationship'; }

function flowsTouching(id) {
  return elements.filter(el => isEdgeType(el.type)
    && (el.attrs?.sourceId === id || el.attrs?.targetId === id));
}

export function getFlowsTouchingAny(ids) {
  const idSet = new Set(ids);
  return elements.filter(el => isEdgeType(el.type)
    && (idSet.has(el.attrs?.sourceId) || idSet.has(el.attrs?.targetId)));
}

function recomputeFlows(ids) {
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  for (const el of elements) {
    if (!isEdgeType(el.type)) continue;
    const sId = el.attrs?.sourceId;
    const tId = el.attrs?.targetId;
    if (!(idSet.has(sId) || idSet.has(tId))) continue;
    const s = sId ? elements.find(e => e.id === sId) : null;
    const t = tId ? elements.find(e => e.id === tId) : null;
    if (el.type === 'bpmn_flow') updateBpmnFlow(el, s, t);
    else updateC4Relationship(el, s, t);
  }
}

function enterEdit(rec) {
  if (editing === rec) return;
  exitEdit();
  editing = rec;
  const input = rec.node.querySelector('input, textarea');
  const hit = rec.node.querySelector('.board-edit-hit');
  rec.node.classList.add('editing');
  // hit rect остаётся видимым (SVG-рамка вокруг edit-области, все 4
  // стороны), но клики пропускает — их ловит input под ним.
  if (hit) hit.style.pointerEvents = 'none';
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
  editing.node.classList.remove('editing');
  if (hit) hit.style.pointerEvents = '';
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
  // Card #134: label-mode text держит rec.y как baseline-center,
  // wrap-mode (и все остальные типы) — как top-left.
  if (rec.type === 'text' && !(rec.attrs && rec.attrs.wrap)) {
    return { x: rec.x, y: rec.y - rec.h / 2, w: rec.w, h: rec.h };
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

export function getChildrenOf(parentId) {
  return childrenOf(parentId);
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
  if (handleEl && onlySel && (onlySel.type === 'frame' || onlySel.type === 'rect' || onlySel.type === 'oval' || onlySel.type === 'image' || onlySel.type === 'note' || onlySel.type === 'text' || isBpmnShape(onlySel.type) || isC4Shape(onlySel.type))) {
    // Card #134: первое таскание handle на label-text → конверсия в
    // wrap-mode. Меняем input → textarea, перепривязываем rec.y от
    // baseline-center к top, attrs.wrap=true. После этого resize идёт
    // как для rect/note (top-anchored).
    if (onlySel.type === 'text' && !(onlySel.attrs && onlySel.attrs.wrap)) {
      convertTextToWrap(onlySel);
    }
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
    if (tool === 'image') { promptAndPlaceImage(p.x, p.y); onToolUsed(); e.preventDefault(); return; }
    if (tool === 'image-file') { pickFileAndPlaceImage(p.x, p.y); onToolUsed(); e.preventDefault(); return; }
    if (tool === 'bpmn_flow') {
      const target = findShape(e.target);
      const ok = target && isBpmnShape(target.type);
      if (!ok) {
        // клик мимо — сбрасываем выбор source/инструмент
        if (flowStart) flowStart.node.classList.remove('bpmn-flow-source');
        flowStart = null;
        onToolUsed();
        e.preventDefault();
        return;
      }
      if (!flowStart) {
        flowStart = target;
        target.node.classList.add('bpmn-flow-source');
        e.preventDefault();
        return;
      }
      if (target.id === flowStart.id) {
        flowStart.node.classList.remove('bpmn-flow-source');
        flowStart = null;
        e.preventDefault();
        return;
      }
      // создаём flow
      const node = createBpmnFlow();
      layerContent.appendChild(node);
      const rec = register({
        id: uuid(), type: 'bpmn_flow', node,
        x: 0, y: 0, w: 0, h: 0,
        attrs: { sourceId: flowStart.id, targetId: target.id },
        parentId: null,
      });
      updateBpmnFlow(rec, flowStart, target);
      flowStart.node.classList.remove('bpmn-flow-source');
      flowStart = null;
      onElementCreated(rec);
      onToolUsed();
      e.preventDefault();
      return;
    }
    if (tool === 'c4_relationship') {
      const target = findShape(e.target);
      const ok = target && isC4Shape(target.type);
      if (!ok) {
        if (c4RelStart) c4RelStart.node.classList.remove('c4-rel-source');
        c4RelStart = null;
        onToolUsed();
        e.preventDefault();
        return;
      }
      if (!c4RelStart) {
        c4RelStart = target;
        target.node.classList.add('c4-rel-source');
        e.preventDefault();
        return;
      }
      if (target.id === c4RelStart.id) {
        c4RelStart.node.classList.remove('c4-rel-source');
        c4RelStart = null;
        e.preventDefault();
        return;
      }
      const node = createC4Relationship();
      layerContent.appendChild(node);
      const rec = register({
        id: uuid(), type: 'c4_relationship', node,
        x: 0, y: 0, w: 0, h: 0,
        attrs: { sourceId: c4RelStart.id, targetId: target.id },
        parentId: null,
      });
      updateC4Relationship(rec, c4RelStart, target);
      c4RelStart.node.classList.remove('c4-rel-source');
      c4RelStart = null;
      onElementCreated(rec);
      onToolUsed();
      e.preventDefault();
      return;
    }
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
    // BRD-7: mouse-only long-press таймер (touch/pen — не активируем).
    // Если удерживать >1s без движения → override select/move-prep, стартуем rubber.
    if (e.pointerType == null || e.pointerType === 'mouse') {
      startLongPressTimer(p, e);
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
    // BRD-7: long-press на пустоте тоже меняет курсор через 1s
    // (визуальный feedback, что можно рисовать rubber). Обычный short-drag
    // остаётся без курсорного изменения.
    if (e.pointerType == null || e.pointerType === 'mouse') {
      startLongPressTimer(p, e);
    }
    e.preventDefault();
  }
}

// BRD-7: старт таймера long-press на shape'у.
function startLongPressTimer(p, e) {
  cancelLongPressTimer();
  longPressAnchor = { x: p.x, y: p.y, shift: !!e.shiftKey, clientX: e.clientX, clientY: e.clientY };
  longPressTimer = window.setTimeout(triggerLongPress, LONG_PRESS_MS);
}

function cancelLongPressTimer() {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressAnchor = null;
}

function triggerLongPress() {
  longPressTimer = null;
  if (!longPressAnchor) return;
  document.body.classList.add('board-rubber-mode');
  // Если rubber уже стартовал (клик по пустоте) — только курсор меняем,
  // сам rubber не пересоздаём. Помечаем fromLongPress чтобы mouseup без
  // drag'а не сбрасывал существующий selection.
  if (rubber) {
    rubber.fromLongPress = true;
  } else {
    // Long-press на shape'у: отменяем move-prep, стартуем rubber с точки нажатия.
    move = null;
    frameTarget && setFrameTarget(null);
    rubber = {
      startX: longPressAnchor.x,
      startY: longPressAnchor.y,
      shift: longPressAnchor.shift,
      node: null,
      initialSelection: longPressAnchor.shift ? new Set(selectedIds) : new Set(selectedIds),
      fromLongPress: true,
    };
  }
  longPressAnchor = null;
}

function onMove(e) {
  if (pan) {
    viewport.vx = pan.startVx - (e.clientX - pan.startClientX) / viewport.zoom;
    viewport.vy = pan.startVy - (e.clientY - pan.startClientY) / viewport.zoom;
    applyViewBox();
    return;
  }
  // BRD-7: движение >LONG_PRESS_MOVE_PX от anchor'а — отменяем таймер.
  if (longPressAnchor && longPressTimer !== null) {
    const dx = e.clientX - longPressAnchor.clientX;
    const dy = e.clientY - longPressAnchor.clientY;
    if (dx * dx + dy * dy > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) {
      cancelLongPressTimer();
    }
  }
  const p = point(e);
  if (rubber) {
    if (!rubber.node) {
      rubber.node = document.createElementNS(SVG_NS, 'rect');
      rubber.node.classList.add('board-rubber');
      layerOverlay.appendChild(rubber.node);
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
    let minW, minH;
    if (r.el.type === 'note') {
      minW = noteMinWidth(r.el);
      minH = NOTE_MIN_H;
    } else {
      minW = minH = FRAME_MIN;
    }
    if (nw < minW) {
      if (r.handle.includes('w')) nx = right - minW;
      nw = minW;
    }
    if (nh < minH) {
      if (r.handle.includes('n')) ny = bottom - minH;
      nh = minH;
    }
    // event/gateway — квадратные: усредняем размер, привязка к актуальному углу.
    if (r.el.type === 'bpmn_event' || r.el.type === 'bpmn_gateway') {
      const s = Math.max(nw, nh);
      if (r.handle.includes('w')) nx = right - s;
      if (r.handle.includes('n')) ny = bottom - s;
      nw = s; nh = s;
    }
    // image — пропорции: угловой handle всегда; боковой — только если lockAspect.
    if (r.el.type === 'image') {
      const a = r.el.attrs || {};
      const corner = r.handle.length === 2;
      const lock = a.lockAspect !== false;
      if (corner || lock) {
        const aspect = a.aspectRatio || (r.oldW / r.oldH) || 1;
        if (corner) {
          // Управляющая ось — та, где смещение мыши «больше» относительно aspect.
          if (nw / nh > aspect) nw = nh * aspect;
          else nh = nw / aspect;
          if (r.handle.includes('w')) nx = right - nw;
          if (r.handle.includes('n')) ny = bottom - nh;
        } else if (r.handle === 'e' || r.handle === 'w') {
          const cy = r.oldY + r.oldH / 2;
          nh = nw / aspect;
          ny = cy - nh / 2;
        } else if (r.handle === 'n' || r.handle === 's') {
          const cx = r.oldX + r.oldW / 2;
          nw = nh * aspect;
          nx = cx - nw / 2;
        }
      }
    }
    r.el.x = nx; r.el.y = ny; r.el.w = nw; r.el.h = nh;
    if (isBpmnShape(r.el.type)) {
      applyBpmnShapeGeo(r.el.node, r.el.type, nx, ny, nw, nh);
      recomputeFlows([r.el.id]);
    } else if (isC4Shape(r.el.type)) {
      applyC4ShapeGeo(r.el.node, r.el.type, nx, ny, nw, nh);
      recomputeFlows([r.el.id]);
    } else {
      setRectAttrs(r.el.node, nx, ny, nw, nh);
    }
    if (r.el.type === 'image') syncImagePlaceholder(r.el);
    updateHandles(r.el);
    if (getOnlySelected() === r.el) onSelectionChanged(r.el, bboxOf(r.el));
    return;
  }
  if (drag) {
    if (!drag.node) {
      drag.node = createShape(drag.type);
      // BRD-16: drag-preview — это будущий content-элемент; кладём сразу
      // в layerContent, чтобы не было DOM-move при drag-end.
      layerContent.appendChild(drag.node);
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
      if (move.el.type === 'frame' || move.el.type === 'rect' || move.el.type === 'oval' || move.el.type === 'image' || move.el.type === 'note' || move.el.type === 'text' || isBpmnShape(move.el.type) || isC4Shape(move.el.type)) updateHandles(move.el);
      onSelectionChanged(move.el, bboxOf(move.el));
    }
  }
}

function onUp(e) {
  // BRD-7: любой mouseup гарантированно снимает long-press timer и cursor-mode.
  cancelLongPressTimer();
  document.body.classList.remove('board-rubber-mode');
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
      // BRD-7: long-press без drag'а не должен deselect'ить — просто выходим.
      if (rubber.fromLongPress) { rubber = null; return; }
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
      // BRD-5: locked элементы не попадают в massовое выделение (Miro-style).
      // Single-click по locked всё ещё выделяет — чтобы можно было unlock через ctx-toolbar.
      if (isLocked(el)) return false;
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
    // Note: ручной resize выключает autoFit (пользователь выразил намерение
    // задать размер сам). Иначе на следующий input высота схлопнется.
    if (target.type === 'note' && target.attrs && target.attrs.autoFit) {
      target.attrs.autoFit = false;
    }
    onElementChanged(target);
    if (target.type === 'note' && getOnlySelected() === target) {
      onSelectionChanged(target, bboxOf(target));
    }
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
    // Для bpmn/c4-shape click-без-drag разрешён: размещаем default-размером в точке клика.
    if (drag.node && small && isBpmnShape(drag.type)) {
      const def = BPMN_DEFAULTS[drag.type];
      applyBpmnShapeGeo(drag.node, drag.type,
        drag.x1 - def.w / 2, drag.y1 - def.h / 2, def.w, def.h);
    } else if (drag.node && small && isC4Shape(drag.type)) {
      const def = C4_DEFAULTS[drag.type];
      applyC4ShapeGeo(drag.node, drag.type,
        drag.x1 - def.w / 2, drag.y1 - def.h / 2, def.w, def.h);
    } else if (small) {
      if (drag.node) drag.node.remove();
      setFrameTarget(null);
      drag = null;
      return;
    }
    if (drag.node) {
      const attrs = isBpmnShape(drag.type)
        ? (drag.type === 'bpmn_event' ? { kind: 'start' }
          : drag.type === 'bpmn_gateway' ? { kind: 'exclusive' }
          : {})
        : isC4Shape(drag.type)
          ? (drag.type === 'c4_system' ? { kind: 'internal', label: 'System' }
            : drag.type === 'c4_person' ? { kind: 'internal', label: 'Person' }
            : drag.type === 'c4_boundary' ? { kind: 'system', label: 'Boundary' }
            : drag.type === 'c4_container' ? { label: 'Container' }
            : drag.type === 'c4_component' ? { label: 'Component' }
            : {})
          : {};
      const rec = { id: uuid(), type: drag.type, node: drag.node, attrs, parentId: null };
      if (drag.type === 'line') {
        rec.x1 = drag.x1; rec.y1 = drag.y1; rec.x2 = p.x; rec.y2 = p.y;
      } else if (isBpmnShape(drag.type)) {
        const g = small
          ? { x: drag.x1 - BPMN_DEFAULTS[drag.type].w / 2,
              y: drag.y1 - BPMN_DEFAULTS[drag.type].h / 2,
              w: BPMN_DEFAULTS[drag.type].w,
              h: BPMN_DEFAULTS[drag.type].h }
          : normalizeBpmnGeo(drag.type, drag.x1, drag.y1, p.x, p.y);
        rec.x = g.x; rec.y = g.y; rec.w = g.w; rec.h = g.h;
        applyBpmnShapeGeo(rec.node, rec.type, rec.x, rec.y, rec.w, rec.h);
        applyBpmnShapeAttrs(rec.node, rec.type, attrs);
      } else if (isC4Shape(drag.type)) {
        const g = small
          ? { x: drag.x1 - C4_DEFAULTS[drag.type].w / 2,
              y: drag.y1 - C4_DEFAULTS[drag.type].h / 2,
              w: C4_DEFAULTS[drag.type].w,
              h: C4_DEFAULTS[drag.type].h }
          : normalizeC4Geo(drag.type, drag.x1, drag.y1, p.x, p.y);
        rec.x = g.x; rec.y = g.y; rec.w = g.w; rec.h = g.h;
        applyC4ShapeGeo(rec.node, rec.type, rec.x, rec.y, rec.w, rec.h);
        applyC4ShapeAttrs(rec.node, rec.type, attrs);
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
    move = null;
    // Click без shift на элемент из multi-selection без реального drag → свернуть к одному.
    if (!moved && wasInSelection && selectedIds.size > 1) {
      selectShape(el);
      setFrameTarget(null);
      return;
    }
    // BRD-11: containment пересчитывается per-element для каждого не-frame'а
    // в drag-selection. Backend cascade-move идёт по DB.parent_id — если
    // PATCH parent_id остаётся в debounce, ребёнок визуально «вытащен», но
    // в БД ещё child. Принудительный flush гарантирует синхрон.
    if (moved && beforeMap) {
      for (const id of beforeMap.keys()) {
        const elx = elements.find(e => e.id === id);
        if (!elx || elx.type === 'frame') continue;
        const newParent = frameContaining(elx);
        const newParentId = newParent ? newParent.id : null;
        if (newParentId !== elx.parentId) {
          elx.parentId = newParentId;
          if (typeof window.__flushElementSave === 'function') {
            window.__flushElementSave(elx);
          } else {
            onElementChanged(elx);
          }
        }
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
  // BRD-5: toggle `.locked` CSS-класс на shape'у по attrs.locked.
  if (a.locked) rec.node.classList.add('locked');
  else rec.node.classList.remove('locked');
  if (rec.type === 'rect' || rec.type === 'oval') {
    if (a.fill !== undefined) rec.node.setAttribute('fill', a.fill === null ? 'none' : a.fill);
    if (a.stroke !== undefined) rec.node.setAttribute('stroke', a.stroke === null ? 'none' : a.stroke);
    if (a.fillOpacity !== undefined) rec.node.setAttribute('fill-opacity', a.fillOpacity);
    if (a.strokeOpacity !== undefined) rec.node.setAttribute('stroke-opacity', a.strokeOpacity);
    // rx у rect = corner-radius; у ellipse — radius по X (устанавливается
    // из w/2 в setRectAttrs). Не пишем rx на ellipse, чтоб не сломать геометрию.
    if (a.rx !== undefined && rec.type === 'rect') rec.node.setAttribute('rx', a.rx);
    if (a.strokeWidth !== undefined) rec.node.setAttribute('stroke-width', a.strokeWidth);
    return;
  }
  if (rec.type === 'line') {
    if (a.stroke !== undefined) rec.node.setAttribute('stroke', a.stroke === null ? 'none' : a.stroke);
    if (a.strokeWidth !== undefined) rec.node.setAttribute('stroke-width', a.strokeWidth);
    if (a.strokeOpacity !== undefined) rec.node.setAttribute('stroke-opacity', a.strokeOpacity);
    // arrow: 'none' (default) | 'end' | 'both' | 'start'
    const arrow = a.arrow || 'none';
    if (arrow === 'end' || arrow === 'both') {
      rec.node.setAttribute('marker-end', 'url(#board-arrow)');
    } else {
      rec.node.removeAttribute('marker-end');
    }
    if (arrow === 'start' || arrow === 'both') {
      rec.node.setAttribute('marker-start', 'url(#board-arrow)');
    } else {
      rec.node.removeAttribute('marker-start');
    }
    return;
  }
  if (rec.type === 'text') {
    // Card #134: wrap-mode хранит value в textarea (а не input).
    const el = rec.node.querySelector('textarea.board-text-textarea, input.board-text-input');
    if (!el) return;
    const desiredText = a.text == null ? '' : a.text;
    if (el.value !== desiredText) el.value = desiredText;
    if (a.color !== undefined) el.style.color = a.color === null ? '' : a.color;
    // Цвет фона (BRD-4 расширение) — рендерится через backgroundColor
    // input'а/textarea. null = прозрачно.
    if (a.bg !== undefined) el.style.backgroundColor = a.bg === null ? '' : a.bg;
    el.style.fontWeight = a.bold ? '700' : '';
    el.style.fontStyle = a.italic ? 'italic' : '';
    el.style.textDecoration = a.underline ? 'underline' : '';
    if (a.fontSize !== undefined) el.style.fontSize = a.fontSize + 'px';
    if (a.wrap) recomputeTextWrapHeight(rec); else resizeTextWidth(rec);
    return;
  }
  if (rec.type === 'note') {
    const bg = rec.node.querySelector('rect.board-note-bg');
    const ta = rec.node.querySelector('textarea.board-note-textarea');
    if (!ta || !bg) return;
    const desiredText = a.text == null ? '' : a.text;
    if (ta.value !== desiredText) ta.value = desiredText;
    if (a.fill !== undefined) bg.setAttribute('fill', a.fill === null ? 'none' : a.fill);
    if (a.stroke !== undefined) bg.setAttribute('stroke', a.stroke === null ? 'none' : a.stroke);
    if (a.rx !== undefined) bg.setAttribute('rx', a.rx);
    if (a.strokeWidth !== undefined) bg.setAttribute('stroke-width', a.strokeWidth);
    if (a.color !== undefined) ta.style.color = a.color === null ? '' : a.color;
    if (a.fontSize !== undefined) ta.style.fontSize = a.fontSize + 'px';
    if (a.autoFit) requestAnimationFrame(() => recomputeNoteAutoFitHeight(rec));
    return;
  }
  if (rec.type === 'frame') {
    const input = rec.node.querySelector('input.board-frame-title');
    if (!input) return;
    const desiredTitle = a.title == null ? '' : a.title;
    if (input.value !== desiredTitle) input.value = desiredTitle;
    fitFrameTitle(rec);
    return;
  }
  if (rec.type === 'image') {
    // Источник: asset_id (новый путь через media-сервис) или src (legacy).
    let href = '';
    if (a.asset_id) href = assetUrl(a.asset_id);
    else if (a.src) href = a.src;
    rec.node.setAttribute('href', href);
    const fit = a.fit || 'cover';
    const par = fit === 'contain' ? 'xMidYMid meet'
              : fit === 'fill' ? 'none'
              : 'xMidYMid slice';
    rec.node.setAttribute('preserveAspectRatio', par);
    return;
  }
  if (isBpmnShape(rec.type)) {
    applyBpmnShapeAttrs(rec.node, rec.type, a);
    return;
  }
  if (rec.type === 'bpmn_flow') {
    const s = a.sourceId ? elements.find(el => el.id === a.sourceId) : null;
    const t = a.targetId ? elements.find(el => el.id === a.targetId) : null;
    updateBpmnFlow(rec, s, t);
    return;
  }
  if (isC4Shape(rec.type)) {
    applyC4ShapeAttrs(rec.node, rec.type, a);
    return;
  }
  if (rec.type === 'c4_relationship') {
    const s = a.sourceId ? elements.find(el => el.id === a.sourceId) : null;
    const t = a.targetId ? elements.find(el => el.id === a.targetId) : null;
    updateC4Relationship(rec, s, t);
  }
}

function createShape(type) {
  if (isBpmnShape(type)) {
    return createBpmnShape(type, {});
  }
  if (isC4Shape(type)) {
    return createC4Shape(type);
  }
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
  if (type === 'oval') {
    const el = document.createElementNS(SVG_NS, 'ellipse');
    el.setAttribute('fill', '#ffffff');
    el.setAttribute('stroke', '#212529');
    el.setAttribute('stroke-width', '2');
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
  visible.classList.add('board-frame-visible');
  visible.setAttribute('stroke', '#868e96');
  visible.setAttribute('stroke-width', '1.5');
  visible.setAttribute('stroke-dasharray', '6 4');
  visible.setAttribute('pointer-events', 'none');
  const titleFo = document.createElementNS(SVG_NS, 'foreignObject');
  titleFo.classList.add('board-frame-title-fo');
  titleFo.setAttribute('height', '20');
  titleFo.setAttribute('width', 1); // обновится в fitFrameTitle
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
  fitFrameTitle(rec);
  input.addEventListener('input', () => {
    rec.attrs = rec.attrs || {};
    rec.attrs.title = input.value;
    fitFrameTitle(rec);
    onElementChanged(rec);
  });
  attachTextCommit(rec, input, 'title');

  // BRD-4: single click на title = выбор фрейма (как клик на границу) +
  // старт move-drag (тоже как с границы). Dblclick = edit. Без этого
  // клик по input сразу давал focus и редактор, минуя selection.
  input.addEventListener('mousedown', e => {
    if (input.classList.contains('editing')) return;  // in edit — natural focus/caret
    e.preventDefault();   // блокируем focus
    e.stopPropagation();  // и pan/drag хендлер SVG
    const wasInSelection = selectedIds.has(rec.id);
    if (!wasInSelection) selectShape(rec);
    // Инициализируем move-state (эквивалент click'а по границе фрейма).
    if (canMove(rec)) {
      const p = screenToWorld(e.clientX, e.clientY);
      const prepIds = collectMoveTargets(rec, wasInSelection);
      const before = new Map();
      for (const id of prepIds) {
        const el = elements.find(x => x.id === id);
        if (el) before.set(id, snapshotGeoLocal(el));
      }
      move = { el: rec, lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, wasInSelection, before };
    }
  });
  input.addEventListener('dblclick', e => {
    input.classList.add('editing');
    input.focus();
    input.select();
    e.stopPropagation();
  });
  input.addEventListener('blur', () => {
    input.classList.remove('editing');
  });

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
      // Все атрибуты title fo (x/y/width/height/font-size/display) — в
      // fitFrameTitle. Он же обеспечивает «не шире фрейма» и hide-порог.
      fitFrameTitle({ node, x, y, w });
    }
    // Note: foreignObject без title-класса — растягиваем под bg с padding 8.
    if (node.dataset && node.dataset.type === 'note') {
      const noteFo = node.querySelector('foreignObject');
      if (noteFo) {
        noteFo.setAttribute('x', x + 8);
        noteFo.setAttribute('y', y + 8);
        noteFo.setAttribute('width', Math.max(0, w - 16));
        noteFo.setAttribute('height', Math.max(0, h - 16));
      }
    }
    // Card #134: text wrap-mode — fo top-anchored, занимает всю rec-bbox.
    // Setter вызывается во время resize, который для text доступен
    // ТОЛЬКО после конверсии в wrap-mode (см. convertTextToWrap).
    if (node.dataset && node.dataset.type === 'text') {
      const textFo = node.querySelector('foreignObject');
      if (textFo) {
        textFo.setAttribute('x', x);
        textFo.setAttribute('y', y);
        textFo.setAttribute('width', Math.max(0, w));
        textFo.setAttribute('height', Math.max(0, h));
      }
    }
    return;
  }
  if (node.tagName === 'ellipse') {
    // Oval: bbox → cx/cy/rx/ry.
    node.setAttribute('cx', x + w / 2);
    node.setAttribute('cy', y + h / 2);
    node.setAttribute('rx', Math.max(0, w / 2));
    node.setAttribute('ry', Math.max(0, h / 2));
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
  if (isBpmnShape(type)) {
    const g = normalizeBpmnGeo(type, x1, y1, x2, y2);
    applyBpmnShapeGeo(node, type, g.x, g.y, g.w, g.h);
    return;
  }
  if (isC4Shape(type)) {
    const g = normalizeC4Geo(type, x1, y1, x2, y2);
    applyC4ShapeGeo(node, type, g.x, g.y, g.w, g.h);
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
  if (isBpmnShape(el.type)) {
    applyBpmnShapeGeo(el.node, el.type, el.x, el.y, el.w, el.h);
    recomputeFlows([el.id]);
    return;
  }
  if (isC4Shape(el.type)) {
    applyC4ShapeGeo(el.node, el.type, el.x, el.y, el.w, el.h);
    recomputeFlows([el.id]);
    return;
  }
  if (el.type === 'rect' || el.type === 'image') {
    el.node.setAttribute('x', el.x);
    el.node.setAttribute('y', el.y);
    if (el.type === 'image') syncImagePlaceholder(el);
    return;
  }
  if (el.type === 'oval') {
    // SVG <ellipse> позиционируется через cx/cy/rx/ry, а не x/y.
    // Раньше moveBy ставил x/y — ellipse их игнорировал, поэтому во время
    // drag двигался только selection-контур (bboxOf честно возвращал новый
    // rec.x/y), а сам овал прыгал в конечное положение только после
    // mouseup, когда что-то перерисовывало атрибуты. setRectAttrs
    // конвертирует bbox → cx/cy/rx/ry.
    setRectAttrs(el.node, el.x, el.y, el.w, el.h);
    return;
  }
  if (el.type === 'frame') {
    setRectAttrs(el.node, el.x, el.y, el.w, el.h);
    return;
  }
  if (el.type === 'text') {
    const fo = el.node.querySelector('foreignObject');
    const hit = el.node.querySelector('.board-edit-hit');
    // Card #134: label-mode держит rec.y как baseline-center (fo.y = y - h/2),
    // wrap-mode (textarea) — rec.y = top (fo.y = y). moveBy сдвигал fo всегда
    // на -h/2, что уводило wrap-текст вверх на половину высоты относительно
    // bboxOf-контура. Fix: смотрим attrs.wrap.
    const isWrap = !!(el.attrs && el.attrs.wrap);
    const off = isWrap ? 0 : el.h / 2;
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
    // BRD-5: locked элемент — handles не показываем (resize запрещён).
    const eligible = only.type === 'frame' || only.type === 'rect' || only.type === 'oval'
      || only.type === 'image' || only.type === 'note' || only.type === 'text'
      || isBpmnShape(only.type) || isC4Shape(only.type);
    if (eligible && !isLocked(only)) showHandlesFor(only);
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
    if (rec._placeholder) { rec._placeholder.remove(); rec._placeholder = null; }
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
  if (rec.type === 'rect' || rec.type === 'oval' || rec.type === 'frame' || rec.type === 'image') {
    setRectAttrs(rec.node, rec.x, rec.y, rec.w, rec.h);
    if (rec.type === 'image') syncImagePlaceholder(rec);
    return;
  }
  if (isBpmnShape(rec.type)) {
    applyBpmnShapeGeo(rec.node, rec.type, rec.x, rec.y, rec.w, rec.h);
    recomputeFlows([rec.id]);
    return;
  }
  if (rec.type === 'bpmn_flow') {
    const a = rec.attrs || {};
    const s = a.sourceId ? elements.find(el => el.id === a.sourceId) : null;
    const t = a.targetId ? elements.find(el => el.id === a.targetId) : null;
    updateBpmnFlow(rec, s, t);
    return;
  }
  if (isC4Shape(rec.type)) {
    applyC4ShapeGeo(rec.node, rec.type, rec.x, rec.y, rec.w, rec.h);
    recomputeFlows([rec.id]);
    return;
  }
  if (rec.type === 'c4_relationship') {
    const a = rec.attrs || {};
    const s = a.sourceId ? elements.find(el => el.id === a.sourceId) : null;
    const t = a.targetId ? elements.find(el => el.id === a.targetId) : null;
    updateC4Relationship(rec, s, t);
    return;
  }
  if (rec.type === 'text') {
    const fo = rec.node.querySelector('foreignObject');
    const hit = rec.node.querySelector('.board-edit-hit');
    // Card #134: wrap-mode → rec.y = top, label-mode → rec.y = baseline center.
    const wrap = rec.attrs && rec.attrs.wrap;
    const foY = wrap ? rec.y : rec.y - rec.h / 2;
    if (fo) { fo.setAttribute('x', rec.x); fo.setAttribute('y', foY); fo.setAttribute('width', rec.w); fo.setAttribute('height', rec.h); }
    if (hit) { hit.setAttribute('x', rec.x); hit.setAttribute('y', foY); hit.setAttribute('width', rec.w); hit.setAttribute('height', rec.h); }
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
  if (rec.type === 'text' && !(rec.attrs && rec.attrs.wrap)) resizeTextWidth(rec);
  if (getOnlySelected() === rec) {
    if (rec.type === 'frame' || rec.type === 'rect' || rec.type === 'oval' || rec.type === 'image' || rec.type === 'note' || rec.type === 'text' || isBpmnShape(rec.type) || isC4Shape(rec.type)) updateHandles(rec);
    onSelectionChanged(rec, bboxOf(rec));
  }
}

// Snapshot геометрии (x, y, w, h, parentId) — для undo before/after извне.
// Для line: (x, y) = (x1, y1), (w, h) = (x2-x1, y2-y1). null если нет элемента.
export function snapshotGeo(id) {
  const rec = elements.find(e => e.id === id);
  return rec ? snapshotGeoLocal(rec) : null;
}

// Клавиатурный nudge выделения на (dx, dy) в world units. Сдвигает selected
// и (для выбранных фреймов) их детей рекурсивно, как одиночный/group drag.
// Без CSS-анимации — рассчитан на серии повторных тапов.
// Возвращает Set<id> затронутых элементов, или null если selection пуст.
export function nudgeSelection(dx, dy) {
  if (selectedIds.size === 0) return null;
  const movingIds = new Set();
  const collect = (rec) => {
    if (movingIds.has(rec.id)) return;
    movingIds.add(rec.id);
    if (rec.type === 'frame') {
      for (const child of childrenOf(rec.id)) collect(child);
    }
  };
  for (const sel of getAllSelected()) collect(sel);
  for (const id of movingIds) {
    const el = elements.find(e => e.id === id);
    if (!el) continue;
    moveBy(el, dx, dy);
    onElementChanged(el);
  }
  const only = getOnlySelected();
  if (only && movingIds.has(only.id)) {
    if (only.type === 'frame' || only.type === 'rect' || only.type === 'oval' || only.type === 'image' || only.type === 'note' || isBpmnShape(only.type) || isC4Shape(only.type)) updateHandles(only);
    onSelectionChanged(only, bboxOf(only));
  }
  return movingIds;
}

// Пересчёт parentId после nudge серии для non-frame элемента: меняет
// parent если центр теперь в другом frame'е. Возвращает {before, after}
// или null если не изменился. Меняет rec.parentId внутри.
export function recomputeParentIdAfterNudge(id) {
  const rec = elements.find(e => e.id === id);
  if (!rec || rec.type === 'frame') return null;
  const newParent = frameContaining(rec);
  const before = rec.parentId || null;
  const after = newParent ? newParent.id : null;
  if (before === after) return null;
  rec.parentId = after;
  return { before, after };
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
        // Immediate flush — backend cascade на следующем drag frame'а
        // должен видеть актуальный parent_id.
        if (typeof window.__flushElementSave === 'function') {
          window.__flushElementSave(el);
        } else {
          onElementChanged(el);
        }
      }
    } else if (el.parentId == null) {
      if (fullyInside) {
        el.parentId = frame.id;
        if (typeof window.__flushElementSave === 'function') {
          window.__flushElementSave(el);
        } else {
          onElementChanged(el);
        }
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

  // Card #134: wrap-mode — textarea + top-anchored fo (rec.y = top
  // left, не baseline center как у label). Геометрия задаётся
  // вызывающим через opts.w/opts.h.
  const wrap = !!opts.wrap;
  const initW = wrap ? (opts.w || 200) : TEXT_MIN_W;
  const initH = wrap ? (opts.h || TEXT_H) : TEXT_H;
  const foY = wrap ? y : y - 12;

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', x);
  fo.setAttribute('y', foY);
  fo.setAttribute('width', initW);
  fo.setAttribute('height', initH);
  let inputEl;
  if (wrap) {
    inputEl = document.createElement('textarea');
    inputEl.className = 'board-text-textarea';
  } else {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'board-text-input';
  }
  inputEl.placeholder = '';
  if (opts.text) inputEl.value = opts.text;
  fo.appendChild(inputEl);

  const hit = document.createElementNS(SVG_NS, 'rect');
  hit.classList.add('board-edit-hit');
  hit.setAttribute('x', x);
  hit.setAttribute('y', foY);
  hit.setAttribute('width', initW);
  hit.setAttribute('height', initH);

  g.appendChild(fo);
  g.appendChild(hit);
  layerContent.appendChild(g);

  const rec = {
    id: opts.id || uuid(),
    type: 'text',
    node: g,
    x, y,
    w: initW, h: initH,
    attrs: { text: opts.text || '', ...(wrap ? { wrap: true } : {}) },
    parentId: opts.parentId || null,
  };
  g.dataset.id = rec.id;
  elements.push(rec);
  if (!wrap) resizeTextWidth(rec);

  inputEl.addEventListener('input', () => {
    rec.attrs.text = inputEl.value;
    if (rec.attrs.wrap) {
      // wrap-mode: width зафиксирована пользователем, h автогрит под
      // scrollHeight textarea (как у note autoFit).
      recomputeTextWrapHeight(rec);
    } else {
      resizeTextWidth(rec);
    }
    onElementChanged(rec);
  });
  attachTextCommit(rec, inputEl, 'text');
  g.addEventListener('dblclick', e => {
    if (isLocked(rec)) { e.stopPropagation(); return; } // BRD-5
    enterEdit(rec); e.stopPropagation();
  });

  if (!opts.id) {
    const f = frameContaining(rec);
    if (f) rec.parentId = f.id;
    onElementCreated(rec);
    enterEdit(rec);
  }
  return rec;
}

// Card #134: конверсия label-text → wrap-text in-place.
// label: <input>, rec.y = baseline center, w auto-fit под value.
// wrap : <textarea>, rec.y = top, w/h явные.
// Триггер — corner-drag первый раз на label-text.
function convertTextToWrap(rec) {
  if (rec.type !== 'text' || (rec.attrs && rec.attrs.wrap)) return;
  const fo = rec.node.querySelector('foreignObject');
  if (!fo) return;
  const oldInput = fo.querySelector('input.board-text-input');
  const value = oldInput ? oldInput.value : (rec.attrs && rec.attrs.text) || '';
  const ta = document.createElement('textarea');
  ta.className = 'board-text-textarea';
  ta.value = value;
  if (oldInput) {
    fo.replaceChild(ta, oldInput);
  } else {
    fo.appendChild(ta);
  }
  // Сдвиг семантики rec.y: было baseline-center, стало top fo.
  rec.y = rec.y - rec.h / 2;
  rec.attrs = { ...(rec.attrs || {}), wrap: true };
  applyGeo(rec);
  // Передёргиваем input-handler — старый слушал input на <input>, теперь
  // нужен на textarea. Привязываем тот же обработчик через replay.
  ta.addEventListener('input', () => {
    rec.attrs.text = ta.value;
    recomputeTextWrapHeight(rec);
    onElementChanged(rec);
  });
  attachTextCommit(rec, ta, 'text');
}

// Card #134: пересчёт высоты wrap-text textarea под content scrollHeight.
function recomputeTextWrapHeight(rec) {
  if (rec.type !== 'text' || !(rec.attrs && rec.attrs.wrap)) return;
  const ta = rec.node.querySelector('textarea.board-text-textarea');
  if (!ta) return;
  const prevH = ta.style.height;
  ta.style.height = '0px';
  const lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const newH = Math.max(ta.scrollHeight, lineH);
  ta.style.height = prevH;
  if (Math.abs(newH - rec.h) < 0.5) return;
  rec.h = newH;
  applyGeo(rec);
  if (getOnlySelected() === rec) updateHandles(rec);
}

export function getCanvasCenterWorld() {
  if (!svg) return { x: 0, y: 0 };
  const r = svg.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

export function placeImage(x, y, source, w, h) {
  return placeImageAt(x, y, source, w, h);
}

// source: либо строка (внешний URL / legacy data:), либо `{ assetId }`.
// Новые upload'ы используют asset_id, старые элементы из БД — могут содержать
// attrs.src (legacy dataURL или https://). applyElementAttrs выбирает.
function placeImageAt(x, y, source, w, h) {
  const placeholder = createImagePlaceholder(x, y, w, h);
  layerContent.appendChild(placeholder);
  const node = document.createElementNS(SVG_NS, 'image');
  node.setAttribute('x', x);
  node.setAttribute('y', y);
  node.setAttribute('width', w);
  node.setAttribute('height', h);
  node.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  const attrs = { fit: 'cover', lockAspect: true, aspectRatio: w / h };
  if (source && typeof source === 'object' && source.assetId) {
    attrs.asset_id = source.assetId;
  } else if (typeof source === 'string' && source) {
    attrs.src = source;
  }
  const rec = register({
    id: uuid(),
    type: 'image',
    node,
    x, y, w, h,
    attrs,
    parentId: null,
  });
  rec._placeholder = placeholder;
  node.addEventListener('load', () => removeImagePlaceholder(rec), { once: true });
  node.addEventListener('error', () => removeImagePlaceholder(rec), { once: true });
  applyElementAttrs(rec);
  layerContent.appendChild(node);
  const f = frameContaining(rec);
  if (f) rec.parentId = f.id;
  onElementCreated(rec);
  return rec;
}

function createImagePlaceholder(x, y, w, h) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('board-image-placeholder');
  g.setAttribute('data-image-placeholder', '');
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.classList.add('image-ph-rect');
  g.appendChild(rect);
  const icon = document.createElementNS(SVG_NS, 'g');
  icon.classList.add('image-ph-icon');
  const iRect = document.createElementNS(SVG_NS, 'rect');
  iRect.setAttribute('x', 0); iRect.setAttribute('y', 0);
  iRect.setAttribute('width', 24); iRect.setAttribute('height', 18);
  iRect.setAttribute('rx', 2);
  icon.appendChild(iRect);
  const iCircle = document.createElementNS(SVG_NS, 'circle');
  iCircle.setAttribute('cx', 8); iCircle.setAttribute('cy', 7); iCircle.setAttribute('r', 1.6);
  icon.appendChild(iCircle);
  const iPath = document.createElementNS(SVG_NS, 'path');
  iPath.setAttribute('d', 'M2 16 L8 10 L12 14 L17 9 L22 14');
  icon.appendChild(iPath);
  g.appendChild(icon);
  g._rect = rect;
  g._icon = icon;
  applyImagePlaceholderGeo(g, x, y, w, h);
  return g;
}

function applyImagePlaceholderGeo(ph, x, y, w, h) {
  ph._rect.setAttribute('x', x);
  ph._rect.setAttribute('y', y);
  ph._rect.setAttribute('width', w);
  ph._rect.setAttribute('height', h);
  const ICON_W = 24, ICON_H = 18;
  const show = Math.min(w, h) >= 32;
  ph._icon.style.display = show ? '' : 'none';
  if (show) {
    const tx = x + (w - ICON_W) / 2;
    const ty = y + (h - ICON_H) / 2;
    ph._icon.setAttribute('transform', `translate(${tx}, ${ty})`);
  }
}

function syncImagePlaceholder(rec) {
  if (rec._placeholder) applyImagePlaceholderGeo(rec._placeholder, rec.x, rec.y, rec.w, rec.h);
}

function removeImagePlaceholder(rec) {
  if (!rec._placeholder) return;
  rec._placeholder.remove();
  rec._placeholder = null;
}

function promptAndPlaceImage(x, y) {
  const url = window.prompt('URL картинки (https://…):');
  if (!url) return null;
  return placeImageAt(x, y, url, 200, 150);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // == backend media (single source)
const IMAGE_MAX_SIDE = 400;

// Читает file → возвращает размеры для placement (без base64). Сам upload —
// через mediaUpload в pickFileAndPlaceImage / pasteImageFromClipboard.
export async function readImageFile(file, { maxBytes = MAX_UPLOAD_BYTES, maxSide = IMAGE_MAX_SIDE } = {}) {
  if (file.size > maxBytes) {
    const mb = (maxBytes / 1024 / 1024).toFixed(0);
    return { error: `Файл слишком большой (${(file.size / 1024 / 1024).toFixed(1)} МБ). Лимит — ${mb} МБ.` };
  }
  const objectUrl = URL.createObjectURL(file);
  const dim = await new Promise(resolve => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth || 200, h: probe.naturalHeight || 150 });
    probe.onerror = () => resolve(null);
    probe.src = objectUrl;
  });
  URL.revokeObjectURL(objectUrl);
  if (!dim) return { error: 'Не удалось прочитать изображение.' };
  let { w, h } = dim;
  if (w > maxSide || h > maxSide) {
    const k = maxSide / Math.max(w, h);
    w = Math.round(w * k);
    h = Math.round(h * k);
  }
  return { file, w, h };
}

function pickFileAndPlaceImage(x, y) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const res = await readImageFile(file);
    if (res.error) { alert(res.error); return; }
    let uploaded;
    try {
      uploaded = await mediaUpload(res.file);
    } catch (e) {
      alert(`Не удалось загрузить картинку: ${e.message}`);
      return;
    }
    placeImageAt(x, y, { assetId: uploaded.id }, res.w, res.h);
  });
  inp.click();
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

  layerContent.appendChild(g);

  const rec = {
    id: opts.id || uuid(),
    type: 'note',
    node: g,
    x, y, w: W, h: H,
    attrs: { text: opts.text || '', autoFit: opts.autoFit ?? true },
    parentId: opts.parentId || null,
  };
  g.dataset.id = rec.id;
  elements.push(rec);

  ta.addEventListener('input', () => {
    rec.attrs.text = ta.value;
    if (rec.attrs.autoFit) recomputeNoteAutoFitHeight(rec);
    onElementChanged(rec);
  });
  attachTextCommit(rec, ta, 'text');
  g.addEventListener('dblclick', e => {
    if (isLocked(rec)) { e.stopPropagation(); return; } // BRD-5
    enterEdit(rec); e.stopPropagation();
  });

  if (!opts.id) {
    const f = frameContaining(rec);
    if (f) rec.parentId = f.id;
    onElementCreated(rec);
    enterEdit(rec);
  } else if (rec.attrs.autoFit && (opts.text || '').length > 0) {
    // На load из API: подогнать h под фактический scrollHeight (textarea
    // могла быть сохранена с большей высотой, чем нужно после wrap policy).
    requestAnimationFrame(() => recomputeNoteAutoFitHeight(rec));
  }
  return rec;
}

// Подгоняет rec.h note под scrollHeight textarea + padding fo (8+8).
// Вызывается из input handler (если attrs.autoFit) и из toggle-button.
// Не персистит сам — вызывающий делает onElementChanged.
export function recomputeNoteAutoFitHeight(rec) {
  if (rec.type !== 'note') return;
  const ta = rec.node.querySelector('textarea.board-note-textarea');
  if (!ta) return;
  // height:auto заставляет textarea пересчитать scrollHeight под content.
  const prevH = ta.style.height;
  ta.style.height = '0px';
  const innerH = Math.max(ta.scrollHeight, parseFloat(getComputedStyle(ta).lineHeight) || 18);
  ta.style.height = prevH;
  const newH = innerH + 16; // fo padding 8 + 8
  if (Math.abs(newH - rec.h) < 0.5) return;
  rec.h = newH;
  applyGeo(rec);
  if (getOnlySelected() === rec) updateHandles(rec);
}

function noteMinWidth(rec) {
  if (rec.type !== 'note') return NOTE_MIN_HARD;
  const ta = rec.node && rec.node.querySelector('textarea.board-note-textarea');
  if (!ta) return NOTE_MIN_HARD;
  const cs = getComputedStyle(ta);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const words = ((rec.attrs && rec.attrs.text) || '').split(/\s+/).filter(Boolean);
  let max = 0;
  for (const w of words) {
    const wd = measureWidth(w, font);
    if (wd > max) max = wd;
  }
  return Math.max(Math.ceil(max + 18), NOTE_MIN_HARD);
}
