# AI Lock Screen — Project Handoff

Это рабочий план проекта, не архив истории — история живёт в `git log` обоих репозиториев. Здесь только: текущее состояние, принятые решения, актуальная архитектура, ограничения, roadmap, правила работы.

## 1. Product

Live wallpaper на экране блокировки: сервер батчами подбирает короткие фразы + визуальный стиль фона, показывается по счётчику разблокировок.

AI Lock Screen — добрый proactive AI-компаньон. Не quote app, не motivational app, не trivia feed, не mindfulness app, не productivity coach, не энциклопедия, не чат — пользователь не отвечает AI с lock screen. Идея: пользователь открывает телефон много раз в день и не знает заранее, что интересного увидит следующим. Контент — добрый, интересный, познавательный, иногда смешной/полезный/персональный, разнообразный, не повторяющийся. Продукт излучает доброту и поддержку, но не морализирует и не коучит.

## 2. Repositories / workflow

- **Android**: `C:\Users\Ермек\OneDrive\Desktop\Баур\Экран блокировка рабочая папка для Claude Code\Rahmet`. Remote не настроен — коммиты локальные.
- **Сервер**: `...\ai-lockscreen-server`, Render (`srv-dae0j4740ujc73d9t81g`), GitHub `JeanNuger/ai-lockscreen-server`.
- Коммит только после того, как реальный DIFF ЦЕЛИКОМ показан сырым текстом в сообщении — не пересказ, не ссылка на вывод инструмента.
- `git push` для сервера — только руками владельца. После пуша проверять на GitHub, что commit hash стал tip'ом `origin/main`.
- Временные debug-хуки — с явным планом уборки отдельным коммитом.
- Маленькие изолированные задачи, по одной за раз до конца, потом следующая.
- Перед новой задачей в сервере — проверить `git status`: параллельный агент может уже менять runtime/test-файлы (см. §9).

## 3. Current Android state

- Live wallpaper pipeline рабочий, актуальный набор — 36 background presets (`AURORA_MESH`/`GRAIN_WASH`/`ORIGAMI_FACETS` × 9 + `GRAIN_WASH_LIGHT` L1-L9 × 9).
- Старые 6 `BackgroundStylePreset` удалены полностью, fallback на `BackgroundPresetV2`.
- Samsung manual clock-color onboarding hint удалён (Top Vignette осталась — независимый механизм, работает с пикселями).
- Background carousel синхронизирована с реальной ротацией текста: продвигается на 1 позицию ровно в момент, когда рационируется текст, не на каждый показ экрана.
- 30-секундный quick-return guard есть; счётчик ротации корректно переживает quick-return-серии на пороге (не теряет "накопленное" решение о смене).
- `DebugForceStyleReceiver` — debug-инструмент, ещё используется, не удалять без отдельного запроса.

## 4. Current Server state

`STYLE_IDS` соответствуют 36 Android-пресетам, Structured Outputs, промпт без клише/выдуманных имён.

**В процессе переделки прямо сейчас** — см. §9, не полагаться на этот раздел как на финальное состояние без проверки `git status`/кода.

## 5. Content product rules

- Batch загружается заранее, конкретная фраза может показаться пользователю часы спустя — не завязывать контент на точное текущее состояние в момент генерации. Предпочитать устойчивый контекст ("сегодня", "сегодня вечером", "теплее вчерашнего") вместо быстро устаревающих точных значений (точные градусы, точное время).
- Утро: первый показ дня — доброе персональное приветствие, формулировка каждый день разная. Погода — естественно, не метеосводкой ("сегодня холоднее, чем вчера", а не точные градусы).
- Ночь: последний показ дня — доброе пожелание спокойной ночи (разная формулировка), но не поток "тишина/звёзды/фонари/философия".
- Праздники и "этот день в истории" — editorial selection, не каждый мелкий инфоповод, коротко и по делу, не энциклопедия.
- Пул категорий контента (не обязательный чеклист на каждый батч): greeting, weather, holiday, history_today, science, country/city facts, word_learning, learning_recall, foreign expressions, humor, useful_knowledge, technology, economics, culture, unusual_fact, riddle/multi-screen curiosity, good_news, seasonal, phone_trend, personal_context, age_context, gender_context (редко, только уместно), city_events (позже), free_ai_thought, goodnight.
- Free AI thought: 1-2 слота (не жёсткая квота), где OpenAI сам придумывает короткое наблюдение — без выдумывания фактов о конкретном пользователе.
- Связанные экраны: иногда один показ создаёт любопытство, следующий подходящий — раскрывает ответ. Использовать умеренно.
- Phone analytics: сервер сам агрегирует (`usage_vs_yesterday=higher` и т.п.), OpenAI никогда не получает сырые `battery=73`/`unlocks=65`. Не в каждом batch. Без психологических/медицинских выводов по telemetry.
- Принцип неповторяемости: избегать не только одинакового текста, но и одинаковых фактов/тем/структуры batch/последовательности категорий/повторяющегося юмора/постоянного phone coaching. У каждой фразы должна быть причина появиться (информирует/развлекает/обучает/персонализирует/удивляет/помогает/приветствует).

## 6. Target content architecture

**Server = WHAT, OpenAI = HOW.** Сейчас OpenAI решает и то, и другое одновременно — целевое направление: сервер решает, ЧТО сказать, OpenAI формулирует, КАК.

- **SlotPlanner / Editorial Planner** — сервер собирает content candidates (окно, дата, пользователь, grounded данные, Daily Bank, Content Memory, Learning Memory, phone trends, cooldown, недавние категории/темы) и выбирает 12 конкретных slots. Не жёсткий чеклист (`greeting → weather → history → ...` каждый день — предсказуемый feed): большой candidate pool, cooldown, controlled/seeded randomness, разные editorial curves. Условные группы без жёсткой квоты: mandatory/anchored (greeting, goodnight, важный праздник), contextual (weather, phone trend, geo, age), educational (history/science/learning/culture/technology/economics), entertainment (humor/riddle/unusual fact/free AI thought), local (city events, позже), personal (имя, известный context, phone patterns).
- Slot — по возможности конкретный WHAT (`type=science, fact_id=..., fact=..., angle=...`), не просто категория. Factual slots (history/science/holiday/facts и т.п.) требуют grounded facts — без них такой slot не выбирается. Creative slots (humor/riddle/free AI thought) могут не иметь factual source, но должны иметь конкретный safe editorial intent, не быть "пустым" заполнителем.
- **Content Memory** — дешёвая серверная память показанного (без embeddings на первом этапе): `device_id`, `content_key`/`topic_hash`, `category`, `shown_at`, `window`, `cooldown_until`. Цель — не повторять факты/темы/категории подряд, знать, когда можно вернуть learning-контент. Нужна retention policy.
- **Learning Memory** — лёгкая обучающая механика (день 1: "слово дня — Х", позже: "помнишь слово Х?"). Не quiz, пользователь не отвечает. Отдельная компактная память на сервере.
- **Daily Bank** — один из источников (date-specific события, holidays, history today, evergreen catalog), не единственный мозг продукта. Без web search на каждого пользователя. City events/афиша — позже, через общий city/date cache (один результат на многих пользователей города).
- **Validators** — остаются как safety net (даты/weekday, stale telemetry, unsupported physical context, явные hallucinations), но не основной способ управления качеством — качество создаётся до OpenAI через editorial planning.
- Dynamic OpenAI payload: компактный список из 12 выбранных slots (`slot_id`, `type`, grounded facts/constraints); ответ маппит `slot_id → text/style_id`. Static prompt — короткий, cache-friendly, не расширять бесконечно запретами (позже пересжать).

## 7. User/profile data

**Продуктовое решение окончательное:** `personal_goal`, `tone` и `interests` удалить из onboarding/profile, не использовать в content architecture, не отправлять OpenAI.
- `personal_goal` — AI не должен строить контент вокруг заявленной жизненной цели.
- `tone` — у продукта одна единая personality: добрый, живой, поддерживающий, ненавязчивый AI, не выбор стиля общения.
- `interests` — несколько выбранных категорий искусственно ограничивают контент и превращают его в повторяющийся тематический feed; AI должен иметь широкий диапазон тем, а не крутиться вокруг анкетных категорий.

Legacy implementation этих полей в Android/server должна быть проверена и физически удалена отдельной implementation task. До этого новая архитектура не должна от них зависеть.

Что остаётся и полезно: имя, возраст/возрастной диапазон (мягкий сигнал), страна/город (локальный контент), пол — редко и осторожно, без стереотипов, накопленные phone trends.

## 8. Cost / scalability constraints

- **1 batch = 1 OpenAI request = ровно 12 фраз.** Не добавлять без отдельного согласования: critic calls, rewrite calls, LLM на каждую фразу, embeddings, персональные web searches, любые дополнительные OpenAI calls.
- Максимум работы — JS/SQL/server logic; OpenAI — там, где реально сильнее (язык, юмор, вариативность, free AI thoughts).
- Погода: пока не усложнять, пользователей мало, текущий бесплатный provider достаточен. Scalability threshold: если API станет платным/лимит близко — сначала geo/city cache, если всё равно невыгодно — временно убрать weather; не допускать незаметных платных расходов. Weather — полезная функция, не фундамент продукта.

## 9. Current implementation / roadmap

**Phase 1 — COMPLETED and committed:** `3cd8495` (`Implement server-side content slot planning`). Server-side SlotPlanner / slot-based OpenAI pipeline реализован; Server = WHAT, OpenAI = HOW; 1 batch = 1 OpenAI request = exactly 12 phrases. Затрагивает `src/contentGenerator.js`, `src/slotPlanner.js`, тесты. Перед любой новой серверной задачей — проверить `git status` и реальный diff, не полагаться на этот документ как на источник актуального implementation status (источник истины — код).

После Phase 1 (порядок ориентировочный, не жёсткий):
- **Phase 2** — server-side phone aggregates (перестать полагаться на raw telemetry в prompt).
- **Phase 3** — Content Memory.
- **Phase 4** — Learning Memory + learning flows.
- **Phase 5** — Daily Bank / content sources improvement.
- **Later** — city events/афиша через cache, дальнейшие расширения.
- Prompt/token optimization — вместе с новой slot-архитектурой, без дополнительных OpenAI calls.

### Ниже приоритетом, не начинать без запроса

- Android "часть B" — проверка читаемости часов на не-Samsung устройстве/эмулятор Pixel.

## 10. Critical safeguards

- Validators — safety net для дат/weekday, stale telemetry, unsupported physical context, hallucinations (см. §6) — не основной механизм качества.
- Никогда не выдумывать факты о конкретном пользователе (включая в free AI thought слотах).
- Batch растянут во времени — не строить контент на точном состоянии, которое устареет к моменту показа (см. §5).
- Phone telemetry — только через агрегаты, без сырых чисел в промпте, без психологических/медицинских выводов (см. §5, §6).
- Личные данные — только реально известные (§7); ничего не придумывать про пол/цели/интересы, если не сообщено.
