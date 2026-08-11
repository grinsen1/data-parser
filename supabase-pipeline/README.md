# Universal Parser v4 — Supabase Pipeline

Миграция с PowerShell-парсера на Supabase + CrUX + PageSpeed.

## Структура

```
supabase-pipeline/
├── supabase/
│   ├── migrations/00001_schema.sql     # База данных
│   ├── functions/
│   │   ├── screenshot/                 # Скриншоты (PageSpeed API)
│   │   ├── crux-rank/                  # CrUX REST API + ранки
│   │   └── process-entries/            # Оркестратор обработки
│   └── config.toml
├── public/index.html                   # PWA-дашборд
├── scripts/
│   └── crux_update.py                  # Обновление CrUX-ранков (без API-ключей)
└── README.md
```

## Быстрый старт

### 1. Supabase проект

```bash
# Установить Supabase CLI
npm install -g supabase

# Инициализировать проект
supabase init
supabase link --project-ref YOUR_PROJECT_REF
```

### 2. База данных

Применить миграцию:
```bash
supabase db push
```

Или вручную выполнить `supabase/migrations/00001_schema.sql` в SQL Editor.

### 3. Переменные окружения (Edge Functions)

```bash
supabase secrets set PAGESPEED_API_KEY=YOUR_GOOGLE_KEY
supabase secrets set DAYS_THRESHOLD=30
```

### 4. Развернуть Edge Functions

```bash
supabase functions deploy screenshot
supabase functions deploy crux-rank
supabase functions deploy process-entries
```

### 5. Загрузить CrUX-ранки (раз в месяц)

```bash
cd scripts
pip install -r requirements.txt
python crux_update.py \
  --supabase-url https://YOUR_PROJECT.supabase.co \
  --supabase-key YOUR_SERVICE_ROLE_KEY
```

### 6. Фронтенд

Заменить в `public/index.html`:
```js
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
```

Задеплоить `public/` на GitHub Pages или Supabase Hosting.

## API

| Edge Function | Назначение |
|---|---|
| `POST /screenshot` | `{ "domain": "example.ru" }` → скриншот |
| `POST /crux-rank` | `{ "id": "example.ru" }` → ранг + метрики |
| `POST /process-entries` | `{ "limit": 50 }` или `{ "id": "example.ru" }` → полный цикл |

## Квоты

| Сервис | Бесплатно |
|---|---|
| CrUX REST API | 25 000 запросов/день (с ключом) |
| PageSpeed API | 25 000 запросов/день (с ключом) |
| crux-top-lists (GitHub) | Безлимитно |
| Supabase Free | 500MB БД, 5GB Storage, 2 Edge Functions |

## Что дальше (TODO)

- [ ] Edge Function: DigitalBudget API (visits, category)
- [ ] Edge Function: google-play-scraper (название, описание, рейтинг)
- [ ] Edge Function: iTunes Search API
- [ ] pg_cron для ежедневной обработки
- [ ] Экспорт в Excel
- [ ] Telegram-уведомления о результатах
