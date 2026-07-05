// settings.js — модалка «Настройки» доски (BRD-3, BRD-8).
//
// Вкладки: «Права доступа» (матрица r/w/s + приглашения + transfer)
// и «Удаление» (BRD-8, видна только owner|curator).
//
// Динамически импортится main.js по клику на «Настройки»/«Поделиться».
// Модуль не должен грузиться у юзера без capability (owner || curator ||
// can_share) — это защита в bundle, а не только UI hidden.
//
// API контракт (BRD-3 D5):
//   GET    /api/v1/boards/{id}/grants                 → list
//   POST   /api/v1/boards/{id}/grants
//     {attrKind, attrValue, canRead, canWrite, canShare}
//   PATCH  /api/v1/boards/{id}/grants/{kind}/{value}
//     {canRead, canWrite, canShare}
//   DELETE /api/v1/boards/{id}/grants/{kind}/{value}
//   POST   /api/v1/boards/{id}/transfer {targetUuid}
//
// BRD-8: вкладка «Удаление».
//   DELETE /api/v1/boards/{id}  → 204 (owner|curator, только пустую).
//     409 board_not_empty при live элементах.

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
    const err = parsed?.error || parsed?.detail?.[0]?.msg || parsed?.detail || res.statusText;
    throw Object.assign(new Error(err), { status: res.status });
  }
  return res;
}

export const grantsApi = {
  list: boardId => apiFetch(`/boards/${boardId}/grants`).then(r => r.json()),
  add: (boardId, body) =>
    apiFetch(`/boards/${boardId}/grants`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(r => r.json()),
  patch: (boardId, kind, value, body) =>
    apiFetch(`/boards/${boardId}/grants/${kind}/${encodeURIComponent(value)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then(r => r.json()),
  remove: (boardId, kind, value) =>
    apiFetch(`/boards/${boardId}/grants/${kind}/${encodeURIComponent(value)}`, {
      method: 'DELETE',
    }),
  transfer: (boardId, targetUuid) =>
    apiFetch(`/boards/${boardId}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ targetUuid }),
    }).then(r => r.json()),
};

export const boardsApi = {
  remove: boardId => apiFetch(`/boards/${boardId}`, { method: 'DELETE' }),
};

const KIND_LABEL = { email: 'EMAIL', telegram: 'TG', handle: 'HANDLE' };

let _current = null; // { board, canManage, canShare }
let _onTransferred = () => {};
let _onDeleted = () => {};
let _wired = false;

export function setOnTransferred(fn) { _onTransferred = fn || (() => {}); }
export function setOnDeleted(fn) { _onDeleted = fn || (() => {}); }
function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function setErr(id, msg) {
  const box = el(id);
  if (!box) return;
  if (!msg) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = msg;
}

// ── Матрица прав ───────────────────────────────────────────────────
function renderMatrix(grants) {
  const list = el('settings-matrix-body');
  list.innerHTML = '';

  const ownerRow = document.createElement('tr');
  ownerRow.className = 'settings-matrix-row settings-matrix-row-owner';
  ownerRow.innerHTML = `
    <td class="settings-cell-subject">
      <span class="settings-role-badge">владелец</span>
      <span class="settings-subject-value" title="Владелец доски">${
        _current.board.ownerUuid ? escapeHtml(_current.board.ownerUuid) : '—'
      }</span>
    </td>
    <td class="settings-cell-cap"><input type="checkbox" checked disabled></td>
    <td class="settings-cell-cap"><input type="checkbox" checked disabled></td>
    <td class="settings-cell-cap"><input type="checkbox" checked disabled></td>
    <td class="settings-cell-del"></td>
  `;
  list.appendChild(ownerRow);

  if (!grants.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `<td colspan="5" class="hint" style="text-align:center;padding:12px;">Пока никому не расшарено.</td>`;
    list.appendChild(emptyRow);
    return;
  }

  for (const g of grants) {
    const row = document.createElement('tr');
    row.className = 'settings-matrix-row';
    const status = g.subjectUuid ? '✓ привязан' : '⏳ ждёт первого захода';
    const roCheckboxes = !_current.canManage;
    row.innerHTML = `
      <td class="settings-cell-subject">
        <span class="settings-kind-badge">${KIND_LABEL[g.subjectAttrKind] || g.subjectAttrKind}</span>
        <span class="settings-subject-value">${escapeHtml(g.subjectAttrValue)}</span>
        <span class="settings-subject-status ${g.subjectUuid ? 'bound' : ''}">${status}</span>
      </td>
      <td class="settings-cell-cap"><input type="checkbox" ${g.canRead ? 'checked' : ''} ${roCheckboxes ? 'disabled' : ''} data-cap="canRead"></td>
      <td class="settings-cell-cap"><input type="checkbox" ${g.canWrite ? 'checked' : ''} ${roCheckboxes ? 'disabled' : ''} data-cap="canWrite"></td>
      <td class="settings-cell-cap"><input type="checkbox" ${g.canShare ? 'checked' : ''} ${roCheckboxes ? 'disabled' : ''} data-cap="canShare"></td>
      <td class="settings-cell-del">${_current.canManage ? '<button class="settings-del-btn" type="button" aria-label="Убрать">×</button>' : ''}</td>
    `;

    if (_current.canManage) {
      row.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const payload = {
            canRead: row.querySelector('[data-cap="canRead"]').checked,
            canWrite: row.querySelector('[data-cap="canWrite"]').checked,
            canShare: row.querySelector('[data-cap="canShare"]').checked,
          };
          if (payload.canWrite && !payload.canRead) payload.canRead = true;
          if (payload.canShare && !payload.canRead) payload.canRead = true;
          if (!payload.canRead && !payload.canWrite && !payload.canShare) {
            if (!confirm('Пустой grant запрещён. Удалить строку?')) {
              await reload(); return;
            }
            await grantsApi.remove(_current.board.id, g.subjectAttrKind, g.subjectAttrValue).catch(() => {});
            await reload();
            return;
          }
          try {
            await grantsApi.patch(_current.board.id, g.subjectAttrKind, g.subjectAttrValue, payload);
            await reload();
          } catch (e) {
            setErr('settings-matrix-err', `Не удалось сохранить: ${e.message}`);
            await reload();
          }
        });
      });
      row.querySelector('.settings-del-btn').addEventListener('click', async () => {
        if (!confirm(`Убрать доступ ${g.subjectAttrKind}: ${g.subjectAttrValue}?`)) return;
        try {
          await grantsApi.remove(_current.board.id, g.subjectAttrKind, g.subjectAttrValue);
          await reload();
        } catch (e) {
          setErr('settings-matrix-err', `Не удалось удалить: ${e.message}`);
        }
      });
    }
    list.appendChild(row);
  }
}

// ── Invite form ────────────────────────────────────────────────────
function renderInviteForm() {
  const readOnlyMode = !_current.canManage;
  el('settings-invite-hint').textContent = readOnlyMode
    ? 'У вас есть право приглашать только для чтения (can_share).'
    : 'Отметьте нужные права; можно комбинировать write+share.';
  const cbR = el('settings-invite-r');
  const cbW = el('settings-invite-w');
  const cbS = el('settings-invite-s');
  cbR.checked = true;
  cbW.checked = false;
  cbS.checked = false;
  cbR.disabled = readOnlyMode;
  cbW.disabled = readOnlyMode;
  cbS.disabled = readOnlyMode;
}

// ── Transfer section ───────────────────────────────────────────────
function renderTransferSection(grants) {
  const section = el('settings-transfer-section');
  if (!_current.board.isOwner) { section.hidden = true; return; }
  section.hidden = false;

  const sel = el('settings-transfer-target');
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
  el('settings-transfer-form').querySelector('button.danger').disabled = targets.length === 0;
}

// ── Delete panel ──────────────────────────────────────────────────
function deleteConfirmTarget() {
  const t = (_current.board.title || '').trim();
  return t || 'удалить';
}

function renderDeletePanel() {
  const tabBtn = document.querySelector('.settings-tab[data-tab="delete"]');
  if (!tabBtn) return;
  const visible = !!_current.canManage;
  tabBtn.hidden = !visible;
  if (!visible) return;
  const target = deleteConfirmTarget();
  const label = el('settings-delete-label');
  const input = el('settings-delete-confirm');
  const btn = el('settings-delete-btn');
  label.textContent = _current.board.title
    ? `Для подтверждения введите название доски: «${target}»`
    : `Для подтверждения введите слово «${target}»`;
  input.placeholder = target;
  input.value = '';
  btn.disabled = true;
  setErr('settings-delete-err', '');
}

function validateDeleteConfirm() {
  const input = el('settings-delete-confirm');
  const btn = el('settings-delete-btn');
  btn.disabled = input.value.trim() !== deleteConfirmTarget();
}

async function reload() {
  if (!_current) return;
  setErr('settings-matrix-err', '');
  setErr('settings-invite-err', '');
  setErr('settings-transfer-err', '');
  try {
    const grants = await grantsApi.list(_current.board.id);
    renderMatrix(grants);
    renderInviteForm();
    renderTransferSection(grants);
    renderDeletePanel();
  } catch (e) {
    el('settings-matrix-body').innerHTML =
      `<tr><td colspan="5" class="hint">Не загрузилось: ${escapeHtml(e.message)}</td></tr>`;
  }
}

// ── Entry points ───────────────────────────────────────────────────

/** Открыть модалку «Настройки» для доски. `focus` ∈ {'matrix'|'invite'}. */
export function openSettings(board, focus = 'matrix') {
  ensureInit();
  _current = {
    board,
    canManage: !!(board.isOwner || board.isCurator),
    canShare: !!(board.isOwner || board.isCurator || board.canShare),
  };
  el('settings-title').textContent = `Настройки: ${board.title || 'Без названия'}`;
  el('settings-invite-value').value = '';
  el('settings-invite-kind').value = 'email';
  updateInvitePlaceholder();
  el('settings-modal').hidden = false;
  activateTab('perms');
  el('settings-matrix-body').innerHTML = '<tr><td colspan="5" class="hint">Загрузка…</td></tr>';
  reload();
  if (focus === 'invite') {
    setTimeout(() => el('settings-invite-value').focus(), 0);
  }
}

/** Alias: «Поделиться» = открыть настройки на секции invite. */
export function openShareModal(board) {
  openSettings(board, 'invite');
}

function close() {
  el('settings-modal').hidden = true;
  _current = null;
}

function activateTab(name) {
  document.querySelectorAll('.settings-tab').forEach(btn => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.settings-panel').forEach(p => {
    const on = p.dataset.panel === name;
    p.classList.toggle('active', on);
    p.hidden = !on;
  });
}

function updateInvitePlaceholder() {
  const kind = el('settings-invite-kind').value;
  const v = el('settings-invite-value');
  if (kind === 'email') v.placeholder = 'user@example.com';
  else if (kind === 'telegram') v.placeholder = '123456789 (numeric tg_id)';
  else v.placeholder = 'user-handle';
}

// Идемпотентный wire-up. Вызывается один раз при первом open.
export function ensureInit() {
  if (_wired) return;
  _wired = true;

  document.querySelectorAll('[data-settings-close]').forEach(x => {
    x.addEventListener('click', close);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el('settings-modal').hidden) close();
  });

  el('settings-invite-kind').addEventListener('change', updateInvitePlaceholder);

  document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.hidden) return;
      activateTab(btn.dataset.tab);
    });
  });

  el('settings-delete-confirm').addEventListener('input', validateDeleteConfirm);

  el('settings-delete-form').addEventListener('submit', async e => {
    e.preventDefault();
    setErr('settings-delete-err', '');
    if (!_current || !_current.canManage) return;
    if (el('settings-delete-confirm').value.trim() !== deleteConfirmTarget()) return;
    el('settings-delete-btn').disabled = true;
    const deletedId = _current.board.id;
    try {
      await boardsApi.remove(deletedId);
      close();
      _onDeleted(deletedId);
    } catch (err) {
      const msg = err.status === 409
        ? 'Сначала удалите все элементы доски.'
        : err.status === 403
          ? 'Нет прав на удаление.'
          : `Не удалось удалить: ${err.message}`;
      setErr('settings-delete-err', msg);
      validateDeleteConfirm();
    }
  });

  el('settings-invite-form').addEventListener('submit', async e => {
    e.preventDefault();
    setErr('settings-invite-err', '');
    if (!_current) return;
    const body = {
      attrKind: el('settings-invite-kind').value,
      attrValue: el('settings-invite-value').value.trim(),
      canRead: el('settings-invite-r').checked,
      canWrite: el('settings-invite-w').checked,
      canShare: el('settings-invite-s').checked,
    };
    if (!body.attrValue) { setErr('settings-invite-err', 'Пустое значение.'); return; }
    if ((body.canWrite || body.canShare) && !body.canRead) body.canRead = true;
    try {
      await grantsApi.add(_current.board.id, body);
      el('settings-invite-value').value = '';
      await reload();
    } catch (e) {
      setErr('settings-invite-err', e.message);
    }
  });

  el('settings-transfer-form').addEventListener('submit', async e => {
    e.preventDefault();
    setErr('settings-transfer-err', '');
    if (!_current) return;
    const target = el('settings-transfer-target').value;
    if (!target) { setErr('settings-transfer-err', 'Сначала выбери получателя.'); return; }
    const label = el('settings-transfer-target').selectedOptions[0]?.textContent || target;
    if (!confirm(
      `Передать владельца «${_current.board.title}» → ${label}?\n\n` +
      `Ты станешь обычным пользователем с правом write. ` +
      `Только новый владелец сможет удалять доску и менять права.`,
    )) return;
    try {
      await grantsApi.transfer(_current.board.id, target);
      close();
      _onTransferred();
    } catch (e) {
      setErr('settings-transfer-err', e.message);
    }
  });
}
