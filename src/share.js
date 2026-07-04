// share.js — модалка управления grants для доски (#130 Stage 7).
//
// Stage 7a: добавление + список + delete по 3 каналам (email/telegram/handle).
// Stage 7b: transfer ownership — добавится позже.
// Stage 7c: hide-controls для not-owner + owner badge — отдельным проходом.
//
// Контракт API из карты #130 (Stages 4 + 5 R-rework):
//   GET    /api/v1/boards/{id}/grants                       → list
//   POST   /api/v1/boards/{id}/grants {attrKind,attrValue,level}
//   DELETE /api/v1/boards/{id}/grants/{attrKind}/{attrValue}

const BASE = '/api/v1';

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    const err = parsed?.error || parsed?.detail?.[0]?.msg || res.statusText;
    throw Object.assign(new Error(err), { status: res.status });
  }
  return res;
}

export const shareApi = {
  list: boardId => apiFetch(`/boards/${boardId}/grants`).then(r => r.json()),
  add: (boardId, body) =>
    apiFetch(`/boards/${boardId}/grants`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(r => r.json()),
  remove: (boardId, attrKind, attrValue) =>
    apiFetch(
      `/boards/${boardId}/grants/${attrKind}/${encodeURIComponent(attrValue)}`,
      { method: 'DELETE' },
    ),
  transfer: (boardId, targetUuid) =>
    apiFetch(`/boards/${boardId}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ targetUuid }),
    }).then(r => r.json()),
};

// Callback из main.js — обновить boards после transfer (owner может
// поменяться → UI-controls пересчитать).
let _onTransferred = () => {};
export function setOnTransferred(fn) { _onTransferred = fn || (() => {}); }

const KIND_LABEL = { email: 'EMAIL', telegram: 'TG', handle: 'HANDLE' };
const LEVEL_LABEL = { 300: 'write', 200: 'read' };

let _current = null; // { boardId, title }

function el(id) { return document.getElementById(id); }

function setErr(msg) {
  const box = el('share-form-err');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

function renderGrants(grants) {
  const list = el('share-grants-list');
  list.innerHTML = '';
  if (!grants.length) {
    list.innerHTML = '<div class="hint">Пока никому не расшарено.</div>';
    return;
  }
  for (const g of grants) {
    const row = document.createElement('div');
    row.className = 'share-grant-row';
    const status = g.subjectUuid ? '✓ привязан' : '⏳ ждёт первого захода';
    row.innerHTML = `
      <span class="share-grant-kind">${KIND_LABEL[g.subjectAttrKind] || g.subjectAttrKind}</span>
      <span class="share-grant-value">${escapeHtml(g.subjectAttrValue)}</span>
      <span class="share-grant-status ${g.subjectUuid ? 'bound' : ''}">${status}</span>
      <span class="share-grant-level">${LEVEL_LABEL[g.level] || g.level}</span>
    `;
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'share-grant-del';
    delBtn.textContent = 'Убрать';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Убрать доступ ${g.subjectAttrKind}: ${g.subjectAttrValue}?`)) return;
      try {
        await shareApi.remove(_current.boardId, g.subjectAttrKind, g.subjectAttrValue);
        await reload();
      } catch (e) {
        setErr(`Не удалось удалить: ${e.message}`);
      }
    });
    row.appendChild(delBtn);
    list.appendChild(row);
  }
}

// Stage 7b — выпадающий список «передать владельца». Доступные — только
// resolved (subject_uuid != null), уникальные по uuid (если шарили по
// двум каналам — один пункт в списке).
function renderTransferTargets(grants) {
  const sel = el('share-transfer-target');
  const seen = new Set();
  const targets = [];
  for (const g of grants) {
    if (!g.subjectUuid || seen.has(g.subjectUuid)) continue;
    seen.add(g.subjectUuid);
    targets.push(g);
  }
  sel.innerHTML = '<option value="">— выбери получателя из расшаренных —</option>';
  for (const g of targets) {
    const opt = document.createElement('option');
    opt.value = g.subjectUuid;
    opt.textContent = `${KIND_LABEL[g.subjectAttrKind] || g.subjectAttrKind}: ${g.subjectAttrValue}`;
    sel.appendChild(opt);
  }
  const btn = el('share-transfer-form').querySelector('button.danger');
  btn.disabled = targets.length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function setTransferErr(msg) {
  const box = el('share-transfer-err');
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

async function reload() {
  if (!_current) return;
  setErr('');
  setTransferErr('');
  try {
    const grants = await shareApi.list(_current.boardId);
    renderGrants(grants);
    renderTransferTargets(grants);
  } catch (e) {
    el('share-grants-list').innerHTML =
      `<div class="hint">Не загрузилось: ${escapeHtml(e.message)}</div>`;
  }
}

function open(board) {
  _current = { boardId: board.id, title: board.title || 'Без названия' };
  el('share-title').textContent = `Поделиться: ${_current.title}`;
  el('share-value').value = '';
  el('share-kind').value = 'email';
  el('share-level').value = '300';
  setErr('');
  el('share-grants-list').innerHTML = '<div class="hint">Загрузка…</div>';
  el('share-modal').hidden = false;
  reload();
  // фокус в input
  setTimeout(() => el('share-value').focus(), 0);
}

function close() {
  el('share-modal').hidden = true;
  _current = null;
}

function _updatePlaceholder() {
  const kind = el('share-kind').value;
  const v = el('share-value');
  if (kind === 'email') v.placeholder = 'user@example.com';
  else if (kind === 'telegram') v.placeholder = '123456789 (numeric tg_id)';
  else v.placeholder = 'user-handle';
}

export function initShare() {
  // Close handlers
  document.querySelectorAll('[data-share-close]').forEach(el => {
    el.addEventListener('click', close);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el('share-modal').hidden) close();
  });
  // Kind change → placeholder
  el('share-kind').addEventListener('change', _updatePlaceholder);
  _updatePlaceholder();
  // Submit share-form
  el('share-form').addEventListener('submit', async e => {
    e.preventDefault();
    setErr('');
    if (!_current) return;
    const body = {
      attrKind: el('share-kind').value,
      attrValue: el('share-value').value.trim(),
      level: Number(el('share-level').value),
    };
    if (!body.attrValue) { setErr('Пустое значение.'); return; }
    try {
      await shareApi.add(_current.boardId, body);
      el('share-value').value = '';
      await reload();
    } catch (e) {
      setErr(e.message);
    }
  });
  // Submit transfer-form (Stage 7b)
  el('share-transfer-form').addEventListener('submit', async e => {
    e.preventDefault();
    setTransferErr('');
    if (!_current) return;
    const target = el('share-transfer-target').value;
    if (!target) { setTransferErr('Сначала выбери получателя.'); return; }
    const targetLabel = el('share-transfer-target').selectedOptions[0]?.textContent || target;
    if (!confirm(
      `Передать владельца «${_current.title}» → ${targetLabel}?\n\n` +
      `Ты станешь обычным пользователем с правом write. ` +
      `Только новый владелец сможет удалять доску и менять права.`,
    )) return;
    try {
      await shareApi.transfer(_current.boardId, target);
      close();
      _onTransferred();
    } catch (e) {
      setTransferErr(e.message);
    }
  });
}

export function openShareModal(board) {
  open(board);
}
