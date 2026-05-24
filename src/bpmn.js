// BPMN-фигуры: events, tasks, gateways, sequence flows.
// Координаты/размер хранятся в общих rec.x/y/w/h (как у rect/frame). Подтипы — в rec.attrs:
//   bpmn_event: { kind: 'start'|'intermediate'|'end', label? }   — w=h, рисуется круг
//   bpmn_task:  { label? }                                       — rounded rect
//   bpmn_gateway: { kind: 'exclusive'|'parallel'|'inclusive', label? } — w=h, ромб
//   bpmn_flow: { sourceId, targetId, label? }                    — path-стрелка от source к target

const SVG_NS = 'http://www.w3.org/2000/svg';

export const BPMN_SHAPE_TYPES = new Set(['bpmn_event', 'bpmn_task', 'bpmn_gateway']);
export const BPMN_TYPES = new Set(['bpmn_event', 'bpmn_task', 'bpmn_gateway', 'bpmn_flow']);

// Размер по умолчанию при click-без-drag для event/gateway (квадратные) и task.
export const BPMN_DEFAULTS = {
  bpmn_event: { w: 56, h: 56 },
  bpmn_task: { w: 140, h: 80 },
  bpmn_gateway: { w: 56, h: 56 },
};

export function isBpmnShape(type) { return BPMN_SHAPE_TYPES.has(type); }
export function isBpmnType(type) { return BPMN_TYPES.has(type); }

// Установить <defs> с arrow-marker для sequence flow. Идемпотентно.
export function ensureBpmnDefs(svg) {
  if (svg.querySelector('defs marker#bpmn-arrow')) return;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'bpmn-arrow');
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

// Создать SVG-ноду для bpmn-shape (event/task/gateway). Внутри <g>:
//   - "shape" element (circle/rect/polygon)
//   - "symbol" text (для gateway: ×/+/○; для event-end — пусто; для event с двойным контуром — overlay circle)
//   - foreignObject с input для label
export function createBpmnShape(type, attrs) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('bpmn-shape');
  g.dataset.bpmnType = type;

  if (type === 'bpmn_event') {
    const outer = document.createElementNS(SVG_NS, 'circle');
    outer.classList.add('bpmn-event-outer');
    outer.setAttribute('fill', '#ffffff');
    outer.setAttribute('stroke', '#212529');
    g.appendChild(outer);
    // Внутренний круг для intermediate (двойной контур). End — тот же outer с толстой обводкой.
    const inner = document.createElementNS(SVG_NS, 'circle');
    inner.classList.add('bpmn-event-inner');
    inner.setAttribute('fill', 'none');
    inner.setAttribute('stroke', '#212529');
    inner.setAttribute('display', 'none');
    g.appendChild(inner);
  } else if (type === 'bpmn_task') {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('bpmn-task-rect');
    rect.setAttribute('fill', '#ffffff');
    rect.setAttribute('stroke', '#212529');
    rect.setAttribute('stroke-width', '2');
    rect.setAttribute('rx', '8');
    g.appendChild(rect);
  } else if (type === 'bpmn_gateway') {
    const poly = document.createElementNS(SVG_NS, 'polygon');
    poly.classList.add('bpmn-gateway-poly');
    poly.setAttribute('fill', '#ffffff');
    poly.setAttribute('stroke', '#212529');
    poly.setAttribute('stroke-width', '2');
    g.appendChild(poly);
    const sym = document.createElementNS(SVG_NS, 'text');
    sym.classList.add('bpmn-gateway-symbol');
    sym.setAttribute('text-anchor', 'middle');
    sym.setAttribute('dominant-baseline', 'central');
    sym.setAttribute('font-size', '28');
    sym.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
    sym.setAttribute('fill', '#212529');
    sym.setAttribute('pointer-events', 'none');
    g.appendChild(sym);
  }

  // Label foreignObject (для event — снизу под кругом; для task — внутри; для gateway — внизу).
  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.classList.add('bpmn-label-fo');
  fo.setAttribute('pointer-events', 'none');
  const labelDiv = document.createElement('div');
  labelDiv.className = 'bpmn-label';
  fo.appendChild(labelDiv);
  g.appendChild(fo);

  return g;
}

// Геометрия для shape: размещаем внутренние элементы внутри bbox (x, y, w, h).
// Для event и gateway w/h уже выровнены (см. normalizeBpmnGeo).
export function applyBpmnShapeGeo(node, type, x, y, w, h) {
  if (type === 'bpmn_event') {
    const outer = node.querySelector('.bpmn-event-outer');
    const inner = node.querySelector('.bpmn-event-inner');
    const cx = x + w / 2, cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    outer.setAttribute('cx', cx);
    outer.setAttribute('cy', cy);
    outer.setAttribute('r', r);
    inner.setAttribute('cx', cx);
    inner.setAttribute('cy', cy);
    inner.setAttribute('r', Math.max(1, r - 4));
  } else if (type === 'bpmn_task') {
    const rect = node.querySelector('.bpmn-task-rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
  } else if (type === 'bpmn_gateway') {
    const poly = node.querySelector('.bpmn-gateway-poly');
    const sym = node.querySelector('.bpmn-gateway-symbol');
    const cx = x + w / 2, cy = y + h / 2;
    poly.setAttribute('points', `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`);
    sym.setAttribute('x', cx);
    sym.setAttribute('y', cy);
    sym.setAttribute('font-size', Math.max(12, Math.min(w, h) * 0.5));
  }
  // Label под фигурой (для event/gateway) либо внутри (task)
  const fo = node.querySelector('.bpmn-label-fo');
  if (type === 'bpmn_task') {
    fo.setAttribute('x', x);
    fo.setAttribute('y', y);
    fo.setAttribute('width', w);
    fo.setAttribute('height', h);
    const div = fo.firstChild;
    div.classList.add('bpmn-label-inside');
    div.classList.remove('bpmn-label-below');
  } else {
    const labelH = 28;
    fo.setAttribute('x', x - 20);
    fo.setAttribute('y', y + h + 2);
    fo.setAttribute('width', w + 40);
    fo.setAttribute('height', labelH);
    const div = fo.firstChild;
    div.classList.add('bpmn-label-below');
    div.classList.remove('bpmn-label-inside');
  }
}

// Применить attrs (kind, label) к shape-ноде.
export function applyBpmnShapeAttrs(node, type, attrs) {
  const a = attrs || {};
  if (type === 'bpmn_event') {
    const outer = node.querySelector('.bpmn-event-outer');
    const inner = node.querySelector('.bpmn-event-inner');
    const kind = a.kind || 'start';
    if (kind === 'end') {
      outer.setAttribute('stroke-width', '4');
      inner.setAttribute('display', 'none');
    } else if (kind === 'intermediate') {
      outer.setAttribute('stroke-width', '2');
      inner.setAttribute('display', '');
      inner.setAttribute('stroke-width', '2');
    } else {
      outer.setAttribute('stroke-width', '2');
      inner.setAttribute('display', 'none');
    }
  } else if (type === 'bpmn_gateway') {
    const sym = node.querySelector('.bpmn-gateway-symbol');
    const kind = a.kind || 'exclusive';
    sym.textContent = kind === 'parallel' ? '+' : kind === 'inclusive' ? '○' : '×';
  }
  // Label
  const labelDiv = node.querySelector('.bpmn-label');
  if (labelDiv) labelDiv.textContent = a.label || '';
}

// Создать flow-ноду: <g> с <path> и <text> для label.
export function createBpmnFlow() {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('bpmn-shape', 'bpmn-flow-g');

  // Невидимый широкий path для hit-area (clickable line).
  const hit = document.createElementNS(SVG_NS, 'path');
  hit.classList.add('bpmn-flow-hit');
  hit.setAttribute('fill', 'none');
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '14');
  g.appendChild(hit);

  const path = document.createElementNS(SVG_NS, 'path');
  path.classList.add('bpmn-flow-path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#212529');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('marker-end', 'url(#bpmn-arrow)');
  path.setAttribute('pointer-events', 'none');
  g.appendChild(path);

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.classList.add('bpmn-flow-label-fo');
  fo.setAttribute('pointer-events', 'none');
  fo.setAttribute('width', '120');
  fo.setAttribute('height', '20');
  const div = document.createElement('div');
  div.className = 'bpmn-flow-label';
  fo.appendChild(div);
  g.appendChild(fo);

  return g;
}

// Найти точку выхода/входа на границе bbox для линии из (cx,cy) к (tx,ty).
// Простой подход: пересечение прямой с прямоугольником bbox (или кругом для event/gateway).
function edgePoint(rec, tx, ty) {
  const cx = rec.x + rec.w / 2;
  const cy = rec.y + rec.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  if (rec.type === 'bpmn_event') {
    const r = Math.min(rec.w, rec.h) / 2;
    const len = Math.hypot(dx, dy);
    return { x: cx + (dx / len) * r, y: cy + (dy / len) * r };
  }
  if (rec.type === 'bpmn_gateway') {
    // Ромб: |x-cx|/(w/2) + |y-cy|/(h/2) = 1
    const a = rec.w / 2, b = rec.h / 2;
    const t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  // Прямоугольник (task и пр.): пересечение луча с гранью.
  const a = rec.w / 2, b = rec.h / 2;
  const tx1 = Math.abs(dx) > 0 ? a / Math.abs(dx) : Infinity;
  const ty1 = Math.abs(dy) > 0 ? b / Math.abs(dy) : Infinity;
  const t = Math.min(tx1, ty1);
  return { x: cx + dx * t, y: cy + dy * t };
}

// Пересчитать path flow-а. source/target — rec'ы (могут быть null если удалены).
export function updateBpmnFlow(rec, source, target) {
  const hit = rec.node.querySelector('.bpmn-flow-hit');
  const path = rec.node.querySelector('.bpmn-flow-path');
  const labelFo = rec.node.querySelector('.bpmn-flow-label-fo');

  let p1, p2;
  if (source && target) {
    const sCenter = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
    const tCenter = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    p1 = edgePoint(source, tCenter.x, tCenter.y);
    p2 = edgePoint(target, sCenter.x, sCenter.y);
  } else {
    // Висячий flow (source или target удалён) — рисуем по сохранённой геометрии.
    p1 = { x: rec.x, y: rec.y };
    p2 = { x: rec.x + rec.w, y: rec.y + rec.h };
  }
  const d = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
  hit.setAttribute('d', d);
  path.setAttribute('d', d);

  // Обновляем rec.x/y/w/h как нормализованный bbox path-а (нужно для select/inspect).
  rec.x = Math.min(p1.x, p2.x);
  rec.y = Math.min(p1.y, p2.y);
  rec.w = Math.abs(p2.x - p1.x);
  rec.h = Math.abs(p2.y - p1.y);

  // Label по центру
  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  labelFo.setAttribute('x', cx - 60);
  labelFo.setAttribute('y', cy - 22);

  const labelDiv = labelFo.firstChild;
  const text = rec.attrs?.label || '';
  if (labelDiv.textContent !== text) labelDiv.textContent = text;
  labelFo.style.display = text ? '' : 'none';
}

// Нормализовать геометрию при drag-создании: для event/gateway форсим w=h (min);
// также применяем минимальный размер.
export function normalizeBpmnGeo(type, x1, y1, x2, y2) {
  const xMin = Math.min(x1, x2);
  const yMin = Math.min(y1, y2);
  let w = Math.abs(x2 - x1);
  let h = Math.abs(y2 - y1);
  if (type === 'bpmn_event' || type === 'bpmn_gateway') {
    const s = Math.max(w, h, 32);
    return { x: xMin, y: yMin, w: s, h: s };
  }
  if (type === 'bpmn_task') {
    return { x: xMin, y: yMin, w: Math.max(w, 60), h: Math.max(h, 40) };
  }
  return { x: xMin, y: yMin, w, h };
}
