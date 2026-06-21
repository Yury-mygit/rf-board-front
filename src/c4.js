// C4-фигуры: Person, Software System, Container, Component, Boundary, Relationship.
// Координаты/размер хранятся в общих rec.x/y/w/h. Подтипы и стиль — в rec.attrs:
//   c4_person: { label, description?, kind?: 'internal'|'external' } — stick-figure + labelled box
//   c4_system: { label, description?, kind?: 'internal'|'external' } — rounded rect (Brown blue/grey)
//   c4_container: { label, description?, tech? } — rounded rect (Brown medium-blue)
//   c4_component: { label, description?, tech? } — rounded rect (Brown light-blue)
//   c4_boundary: { label, kind?: 'system'|'container' } — dashed rect с заголовком сверху
//   c4_relationship: { sourceId, targetId, label?, tech? } — path-стрелка + label
//
// Палитра — Simon Brown defaults (https://c4model.com/#Notation).

const SVG_NS = 'http://www.w3.org/2000/svg';

export const C4_SHAPE_TYPES = new Set([
  'c4_person', 'c4_system', 'c4_container', 'c4_component', 'c4_boundary',
]);
export const C4_TYPES = new Set([
  'c4_person', 'c4_system', 'c4_container', 'c4_component', 'c4_boundary',
  'c4_relationship',
]);

export const C4_DEFAULTS = {
  c4_person: { w: 120, h: 150 },
  c4_system: { w: 200, h: 110 },
  c4_container: { w: 200, h: 120 },
  c4_component: { w: 180, h: 100 },
  c4_boundary: { w: 360, h: 240 },
};

export function isC4Shape(type) { return C4_SHAPE_TYPES.has(type); }
export function isC4Type(type) { return C4_TYPES.has(type); }

// <defs> с arrow-marker для c4_relationship. Идемпотентно.
export function ensureC4Defs(svg) {
  if (svg.querySelector('defs marker#c4-arrow')) return;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  const marker = document.createElementNS(SVG_NS, 'marker');
  marker.setAttribute('id', 'c4-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '8');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('orient', 'auto-start-reverse');
  marker.setAttribute('markerUnits', 'strokeWidth');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M0 0 L10 5 L0 10 z');
  path.setAttribute('fill', '#707070');
  marker.appendChild(path);
  defs.appendChild(marker);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Палитра — Simon Brown defaults.
const PALETTE = {
  c4_person: {
    internal: { fill: '#08427b', stroke: '#052c5a' },
    external: { fill: '#686868', stroke: '#4a4a4a' },
  },
  c4_system: {
    internal: { fill: '#1168bd', stroke: '#0e589f' },
    external: { fill: '#999999', stroke: '#6e6e6e' },
  },
  c4_container: { fill: '#438dd5', stroke: '#3678b6' },
  c4_component: { fill: '#85bbf0', stroke: '#5d92cc' },
  c4_boundary: { stroke: '#444444' },
};

// Создать SVG-ноду для c4-shape (не relationship).
export function createC4Shape(type) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('c4-shape');
  g.dataset.c4Type = type;

  if (type === 'c4_person') {
    // Stick-figure сверху + labelled box внизу. Все в одном bbox.
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('c4-person-rect');
    rect.setAttribute('rx', '8');
    rect.setAttribute('ry', '8');
    rect.setAttribute('stroke-width', '2');
    g.appendChild(rect);

    const head = document.createElementNS(SVG_NS, 'circle');
    head.classList.add('c4-person-head');
    head.setAttribute('fill', '#ffffff');
    head.setAttribute('stroke', '#052c5a');
    head.setAttribute('stroke-width', '2');
    g.appendChild(head);

    const body = document.createElementNS(SVG_NS, 'path');
    body.classList.add('c4-person-body');
    body.setAttribute('fill', '#ffffff');
    body.setAttribute('stroke', '#052c5a');
    body.setAttribute('stroke-width', '2');
    body.setAttribute('stroke-linejoin', 'round');
    g.appendChild(body);
  } else if (type === 'c4_boundary') {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('c4-boundary-rect');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke-width', '2');
    rect.setAttribute('stroke-dasharray', '8 4');
    rect.setAttribute('rx', '6');
    g.appendChild(rect);
  } else {
    // system / container / component — rounded box
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('c4-box-rect');
    rect.setAttribute('rx', type === 'c4_component' ? '4' : '8');
    rect.setAttribute('stroke-width', '2');
    g.appendChild(rect);
  }

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.classList.add('c4-label-fo');
  fo.setAttribute('pointer-events', 'none');
  const div = document.createElement('div');
  div.className = 'c4-label';
  fo.appendChild(div);
  g.appendChild(fo);

  return g;
}

// Геометрия: разместить внутренности внутри (x, y, w, h).
export function applyC4ShapeGeo(node, type, x, y, w, h) {
  if (type === 'c4_person') {
    const rect = node.querySelector('.c4-person-rect');
    const head = node.querySelector('.c4-person-head');
    const body = node.querySelector('.c4-person-body');

    // Stick-figure занимает верхние ~35% высоты.
    const stickH = Math.max(40, h * 0.35);
    const cx = x + w / 2;
    const headR = Math.min(stickH * 0.28, 14);
    const headCy = y + headR + 4;
    head.setAttribute('cx', cx);
    head.setAttribute('cy', headCy);
    head.setAttribute('r', headR);

    const bodyTop = headCy + headR;
    const bodyBottom = y + stickH - 6;
    const bodyHalfW = Math.min(w * 0.28, 28);
    const bd = `M ${cx} ${bodyTop} L ${cx - bodyHalfW} ${bodyBottom} L ${cx + bodyHalfW} ${bodyBottom} Z`;
    body.setAttribute('d', bd);

    // Лейбл-боксик под stick-figure
    const boxTop = y + stickH;
    const boxH = y + h - boxTop;
    rect.setAttribute('x', x);
    rect.setAttribute('y', boxTop);
    rect.setAttribute('width', w);
    rect.setAttribute('height', boxH);

    const fo = node.querySelector('.c4-label-fo');
    fo.setAttribute('x', x + 4);
    fo.setAttribute('y', boxTop + 4);
    fo.setAttribute('width', w - 8);
    fo.setAttribute('height', boxH - 8);
    fo.firstChild.className = 'c4-label c4-label-inside';
  } else if (type === 'c4_boundary') {
    const rect = node.querySelector('.c4-boundary-rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);

    // Заголовок над верхней границей.
    const labelH = 24;
    const fo = node.querySelector('.c4-label-fo');
    fo.setAttribute('x', x + 12);
    fo.setAttribute('y', y - labelH + 4);
    fo.setAttribute('width', w - 24);
    fo.setAttribute('height', labelH);
    fo.firstChild.className = 'c4-label c4-label-boundary';
  } else {
    const rect = node.querySelector('.c4-box-rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);

    const fo = node.querySelector('.c4-label-fo');
    fo.setAttribute('x', x + 6);
    fo.setAttribute('y', y + 6);
    fo.setAttribute('width', w - 12);
    fo.setAttribute('height', h - 12);
    fo.firstChild.className = 'c4-label c4-label-inside';
  }
}

// Применить attrs (kind/label/description/tech) к c4-shape ноде.
export function applyC4ShapeAttrs(node, type, attrs) {
  const a = attrs || {};
  const kind = a.kind || 'internal';
  const label = a.label || '';
  const description = a.description || '';
  const tech = a.tech || '';

  // Заливка / обводка по типу + kind.
  if (type === 'c4_person') {
    const rect = node.querySelector('.c4-person-rect');
    const p = PALETTE.c4_person[kind] || PALETTE.c4_person.internal;
    rect.setAttribute('fill', a.fill || p.fill);
    rect.setAttribute('stroke', a.stroke || p.stroke);
  } else if (type === 'c4_boundary') {
    const rect = node.querySelector('.c4-boundary-rect');
    rect.setAttribute('stroke', a.stroke || PALETTE.c4_boundary.stroke);
  } else if (type === 'c4_system') {
    const rect = node.querySelector('.c4-box-rect');
    const p = PALETTE.c4_system[kind] || PALETTE.c4_system.internal;
    rect.setAttribute('fill', a.fill || p.fill);
    rect.setAttribute('stroke', a.stroke || p.stroke);
  } else if (type === 'c4_container') {
    const rect = node.querySelector('.c4-box-rect');
    rect.setAttribute('fill', a.fill || PALETTE.c4_container.fill);
    rect.setAttribute('stroke', a.stroke || PALETTE.c4_container.stroke);
  } else if (type === 'c4_component') {
    const rect = node.querySelector('.c4-box-rect');
    rect.setAttribute('fill', a.fill || PALETTE.c4_component.fill);
    rect.setAttribute('stroke', a.stroke || PALETTE.c4_component.stroke);
  }

  // Контент label-FO. Структура HTML: name + meta + description.
  const labelDiv = node.querySelector('.c4-label');
  if (!labelDiv) return;
  let html = '';
  if (type === 'c4_person') {
    const meta = kind === 'external' ? 'External Person' : 'Person';
    html = `<div class="c4-name">${escHtml(label || 'Person')}</div>` +
           `<div class="c4-meta">[${meta}]</div>` +
           (description ? `<div class="c4-desc">${escHtml(description)}</div>` : '');
  } else if (type === 'c4_system') {
    const meta = kind === 'external' ? 'External Software System' : 'Software System';
    html = `<div class="c4-name">${escHtml(label || 'System')}</div>` +
           `<div class="c4-meta">[${meta}]</div>` +
           (description ? `<div class="c4-desc">${escHtml(description)}</div>` : '');
  } else if (type === 'c4_container') {
    const meta = tech ? `Container: ${escHtml(tech)}` : 'Container';
    html = `<div class="c4-name">${escHtml(label || 'Container')}</div>` +
           `<div class="c4-meta">[${meta}]</div>` +
           (description ? `<div class="c4-desc">${escHtml(description)}</div>` : '');
  } else if (type === 'c4_component') {
    const meta = tech ? `Component: ${escHtml(tech)}` : 'Component';
    html = `<div class="c4-name">${escHtml(label || 'Component')}</div>` +
           `<div class="c4-meta">[${meta}]</div>` +
           (description ? `<div class="c4-desc">${escHtml(description)}</div>` : '');
  } else if (type === 'c4_boundary') {
    const bkind = a.kind === 'system' ? 'System' : 'Container';
    html = `<span class="c4-name">${escHtml(label || bkind + ' boundary')}</span>` +
           `<span class="c4-meta"> [${bkind} Boundary]</span>`;
  }
  if (labelDiv.innerHTML !== html) labelDiv.innerHTML = html;
}

// ─── c4_relationship ────────────────────────────────────────────────

export function createC4Relationship() {
  const g = document.createElementNS(SVG_NS, 'g');
  g.classList.add('c4-shape', 'c4-rel-g');

  const hit = document.createElementNS(SVG_NS, 'path');
  hit.classList.add('c4-rel-hit');
  hit.setAttribute('fill', 'none');
  hit.setAttribute('stroke', 'transparent');
  hit.setAttribute('stroke-width', '14');
  g.appendChild(hit);

  const path = document.createElementNS(SVG_NS, 'path');
  path.classList.add('c4-rel-path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#707070');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-dasharray', '6 3');
  path.setAttribute('marker-end', 'url(#c4-arrow)');
  path.setAttribute('pointer-events', 'none');
  g.appendChild(path);

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.classList.add('c4-rel-label-fo');
  fo.setAttribute('pointer-events', 'none');
  fo.setAttribute('width', '160');
  fo.setAttribute('height', '36');
  const div = document.createElement('div');
  div.className = 'c4-rel-label';
  fo.appendChild(div);
  g.appendChild(fo);

  return g;
}

function c4EdgePoint(rec, tx, ty) {
  const cx = rec.x + rec.w / 2;
  const cy = rec.y + rec.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const a = rec.w / 2, b = rec.h / 2;
  const tx1 = Math.abs(dx) > 0 ? a / Math.abs(dx) : Infinity;
  const ty1 = Math.abs(dy) > 0 ? b / Math.abs(dy) : Infinity;
  const t = Math.min(tx1, ty1);
  return { x: cx + dx * t, y: cy + dy * t };
}

// Пересчёт path-а. source/target — rec'ы (либо null если удалены).
export function updateC4Relationship(rec, source, target) {
  const hit = rec.node.querySelector('.c4-rel-hit');
  const path = rec.node.querySelector('.c4-rel-path');
  const labelFo = rec.node.querySelector('.c4-rel-label-fo');

  let p1, p2;
  if (source && target) {
    const sCenter = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
    const tCenter = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    p1 = c4EdgePoint(source, tCenter.x, tCenter.y);
    p2 = c4EdgePoint(target, sCenter.x, sCenter.y);
  } else {
    p1 = { x: rec.x, y: rec.y };
    p2 = { x: rec.x + rec.w, y: rec.y + rec.h };
  }
  const d = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
  hit.setAttribute('d', d);
  path.setAttribute('d', d);

  rec.x = Math.min(p1.x, p2.x);
  rec.y = Math.min(p1.y, p2.y);
  rec.w = Math.abs(p2.x - p1.x);
  rec.h = Math.abs(p2.y - p1.y);

  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  labelFo.setAttribute('x', cx - 80);
  labelFo.setAttribute('y', cy - 40);

  const label = rec.attrs?.label || '';
  const tech = rec.attrs?.tech || '';
  const labelDiv = labelFo.firstChild;
  let html = '';
  if (label) html += `<div class="c4-rel-label-text">${escHtml(label)}</div>`;
  if (tech) html += `<div class="c4-rel-label-tech">[${escHtml(tech)}]</div>`;
  if (labelDiv.innerHTML !== html) labelDiv.innerHTML = html;
  labelFo.style.display = (label || tech) ? '' : 'none';
}

export function normalizeC4Geo(type, x1, y1, x2, y2) {
  const xMin = Math.min(x1, x2);
  const yMin = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (type === 'c4_person') {
    return { x: xMin, y: yMin, w: Math.max(w, 80), h: Math.max(h, 110) };
  }
  if (type === 'c4_boundary') {
    return { x: xMin, y: yMin, w: Math.max(w, 200), h: Math.max(h, 120) };
  }
  if (type === 'c4_component') {
    return { x: xMin, y: yMin, w: Math.max(w, 120), h: Math.max(h, 70) };
  }
  return { x: xMin, y: yMin, w: Math.max(w, 140), h: Math.max(h, 80) };
}
