// Клиент media-сервиса. Бинари (картинки/аудио/etc) хранятся отдельно,
// в board attrs кладём только asset_id; URL фронт строит сам.

const MEDIA_BASE = import.meta.env.VITE_MEDIA_BASE || '';

export function assetUrl(assetId) {
  if (!assetId || !MEDIA_BASE) return '';
  return `${MEDIA_BASE}/api/v1/assets/${assetId}`;
}

export function assetThumbUrl(assetId) {
  if (!assetId || !MEDIA_BASE) return '';
  return `${MEDIA_BASE}/api/v1/assets/${assetId}/thumb`;
}

export async function mediaUpload(file) {
  if (!MEDIA_BASE) throw new Error('VITE_MEDIA_BASE not configured');
  const fd = new FormData();
  fd.append('file', file, file.name || 'upload');
  const res = await fetch(`${MEDIA_BASE}/api/v1/assets`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch {}
    throw new Error(`media upload failed: ${res.status} ${detail}`);
  }
  return res.json();
}
