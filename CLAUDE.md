# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**LiveNotes Web** — веб-клиент для просмотра и редактирования данных встреч (Stage 2 проекта LiveNotes). Android-приложение (`D:\LiveNotes`) записывает контент локально; этот клиент даёт доступ к тем же данным через браузер на большом экране.

Полная концепция: `D:\LiveNotes\CONCEPT.md`. API-контракт: `D:\LiveNotes\API_CONTRACT.md`.

## Стек

Vite + vanilla JS (без фреймворков). Весь JS — один файл `src/main.js`, стили — `src/style.css`.

## Команды

```bash
npm install      # установить зависимости (первый раз)
npm run dev      # dev-сервер на http://127.0.0.1:5173
npm run build    # production-сборка → dist/
npm run preview  # превью production-сборки
```

## Запуск (каждый раз)

Сначала сервер, потом фронт — в двух отдельных терминалах:

```powershell
# Терминал 1 — сервер
cd D:\LiveNotes_server
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Терминал 2 — фронт
cd D:\LiveNotes_front
npm run dev
```

Открыть в браузере: `http://127.0.0.1:5173`

Токен подставляется автоматически из `.env.local` (`VITE_DEV_TOKEN=livenotes_dev_key`).

## Структура файлов

```
D:\LiveNotes_front\
├── index.html          — HTML-оболочка, два элемента: #sessions и #feed
├── vite.config.js      — Vite config: host=127.0.0.1, proxy /api → localhost:8000
├── .env.local          — dev-токен (VITE_DEV_TOKEN), не коммитить
├── package.json        — единственная зависимость: vite
└── src/
    ├── main.js         — весь JS (~320 строк)
    └── style.css       — все стили
```

## Архитектура src/main.js

Файл разбит на секции:

| Секция | Что делает |
|---|---|
| Helpers | `fmtDate`, `fmtTime`, `fmtDuration`, `fmtSize` — форматирование дат, времени, размеров |
| API | `apiFetch` с Bearer-токеном; `api.sessions()`, `api.entries(id)`, `api.patch(id, data)`, `api.blob(id, type)` |
| State | `currentSessionId` — ID выбранной встречи |
| Sessions panel | `renderSessions()` — рендер списка встреч в `#sessions` |
| Entry rendering | `renderEntry()` + `fillSource()` — карточка записи по типу |
| Actions | `loadSessions()`, `openSession(id)`, `setStatus()` |
| Init | Автозаполнение токена, первичная загрузка |

**Медиа** (аудио, видео, фото, файлы) загружаются через `api.blob()` с авторизацией и кешируются в `Map` как Blob URL. Это нужно потому что `<audio src>` и `<img src>` не отправляют Bearer-токен.

**Редактирование заметки** (`note`): textarea с debounce 1 сек → `PATCH /entries/{id}`.

**Сворачивание источника**: кнопка ▲/▼ → `PATCH /entries/{id}` с `isSourceCollapsed`.

## Раскладка UI

```
┌─────────────────────────────────────────────────────┐
│  LiveNotes                        [token] [Подключить]│
├──────────────┬──────────────────────────────────────┤
│ #sessions    │ #feed                                 │
│ 260px фикс.  │ flex: 1, overflow-y: auto            │
│ overflow-y   │                                       │
│ auto         │  .entry-card (flex-shrink: 0)         │
│              │    .entry-source                      │
│              │      .entry-header (иконка + время)   │
│              │      .entry-content (тип-специфичный) │
│              │    .entry-divider (пунктир — «шторка»)│
│              │    .entry-note (textarea)             │
└──────────────┴──────────────────────────────────────┘
```

Ключевые CSS-решения:
- `body` и `#app`: `height: 100vh; overflow: hidden` — страница не скроллится целиком
- `main`: `min-height: 0` — иначе flex-дочерние элементы выходят за пределы viewport
- `.entry-card`: `flex-shrink: 0` — карточки не сжимаются, растут по контенту; скролл на `#feed`

## Типы записей

| Тип | Иконка | Что рендерится |
|---|---|---|
| TEXT | ✏️ | `<p>` с textContent |
| AUDIO | 🎙 | `<audio controls>` + транскрипция + длительность |
| PHOTO | 📷 | `<img>` на полную ширину карточки |
| VIDEO | 🎬 | `<video controls>` max-height 360px + poster (thumbnail) |
| FILE | 📎 | ссылка для скачивания + размер файла |

## Что сделано

- [x] Просмотр списка встреч (сортировка по `updatedAt` desc)
- [x] Лента записей встречи (сортировка по `createdAt` asc)
- [x] Отображение всех 5 типов записей
- [x] Воспроизведение аудио и видео с авторизацией через Blob URL
- [x] Просмотр фото
- [x] Скачивание файлов
- [x] Редактирование поля `note` (autosave через 1 сек)
- [x] Сворачивание/разворачивание источника (шторка)
- [x] Автоподстановка dev-токена при старте

## Что можно добавить дальше

- **Кнопка «Распознать»** на AUDIO-карточках (`transcriptionStatus = NONE | ERROR`) → `POST /entries/{id}/transcribe`
- Кнопка «Обновить» (перезагрузить список встреч / ленту)
- Создание новых встреч и текстовых записей прямо из браузера
- Редактирование названия встречи
- Поиск по записям
- Индикатор сохранения заметки (spinner / ✓)
- Полноэкранный просмотр фото
- Реализация `POST /sync` для двусторонней синхронизации с Android

## Серверная транскрипция (добавлена 2026-04-27)

На сервере появился Whisper (`faster-whisper`, модель `small`, CPU, int8).

**Новый эндпоинт:**
```
POST /api/v1/entries/{entry_id}/transcribe
```
- Работает только для записей типа `AUDIO` у которых `hasMedia: true`
- Синхронный ответ (ждёт пока Whisper отработает):
  ```json
  { "transcription": "текст...", "status": "done" }
  ```
- В процессе выставляет `transcriptionStatus = IN_PROGRESS`, по завершении `DONE` или `ERROR`
- Модель загружается один раз при старте сервера (`lifespan` → `load_model()`)
- Язык фиксирован: русский

**Что нужно добавить во фронт:** кнопка «Распознать» на AUDIO-карточках, у которых `transcriptionStatus` равен `NONE` или `ERROR`. После нажатия — POST запрос, затем обновить карточку с полученной транскрипцией.

## API

Base URL (через прокси Vite): `/api/v1`  
Auth: `Authorization: Bearer <token>` на каждый запрос  
Все timestamps — Unix ms. Все ID — UUID-строки.

Подробный контракт: `D:\LiveNotes\API_CONTRACT.md`  
Параметры сервера: `D:\LiveNotes_server\DEV_ACCESS.md`
