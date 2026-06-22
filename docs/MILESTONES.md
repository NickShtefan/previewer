# MVP — план по майлстоунам

Декомпозиция MVP на инкрементальные, независимо тестируемые майлстоуны. Каждый строится «по одному».

**Ключевые точки:**
- **Walking skeleton at M5** — первое реальное ревью на одном репо, триггер вручную через CLI.
- **Autonomous MVP at M7** — событийный, multi-repo, с гарантией полноты. Это и есть «MVP».
- **Feature-complete at M9** — экономия токенов, incremental, второй runner, аудит costs.

## Граф зависимостей

```
M0 ──┬─▶ M1 ─┐
     ├─▶ M2 ─┤
     ├─▶ M3 ─┼─▶ M5 ──┬─▶ M6 (webhook)
     └─▶ M4 ─┘        ├─▶ M7 (reconciler)   ← «MVP» здесь
                      └─▶ M8 (onboarding)   ← можно сразу после M5
                              │
                              └─▶ M9 (cost & polish)
```

`M1–M4` независимы и распараллеливаются. `M5` — интеграционный. `M8` зависит только от `M3+M4`
(можно вынести вперёд, если приоритет — онбординг новых репо). Легенда оценок: **S** ≈ полдня,
**M** ≈ 1–2 дня, **L** ≈ 3–4 дня.

---

## M0 — Skeleton & Contracts  ✅ (этот шаг)

**Цель.** Структура проекта, все форматы как zod-схемы, core-интерфейсы, стабы — компилируется.

**Ценность.** Зафиксированные контракты, от которых строятся остальные майлстоуны без переписываний.

**Входит.** `src/config/schema/*` (все форматы), `src/config` loader, `src/core/*` (Store, Queue, Runner,
ContextProvider, Publisher, GitHubClient, Policy), стабы модулей с `NotImplementedError("… (Mx)")`,
4 app-entrypoint’а, example pack, `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, toolchain.

**Артефакты.** Вся текущая файловая структура.

**Критерии приёмки.**
- `npm run typecheck` — зелёный.
- `npm run cli -- help` — печатает список команд.
- Каждый формат из ARCHITECTURE имеет zod-схему + inferred type.

**Зависимости.** —  **Оценка.** ✅

---

## M1 — Persistence: Store & Queue (SQLite)  ✅

**Статус.** Готово, зелёное (10 тестов): dedupe, audit-upsert, lease/visibility-timeout, retry-delay,
dead_letter, stale-ack, delivery-идемпотентность. Артефакты: [`src/store/`](../src/store) (`db`,
`migrations`, `sqlite-store`, `sqlite-queue`, `createStores`), [`tests/store.test.ts`](../tests/store.test.ts).

**Цель.** Durable backbone: dedupe, run/audit-записи, очередь с lease/retry/dead-letter.

**Ценность.** Идемпотентность и надёжность без внешних сервисов; всё тестируется на `:memory:`.

**Входит.** SQL-схема + миграции; `SqliteStore` (`claimReview` через `INSERT … ON CONFLICT DO NOTHING`,
`recordRun`, `lastReviewedSha`, `seenDelivery`/`markDelivery`); `SqliteQueue` (`enqueue` UNIQUE,
`lease` с visibility-timeout, `ack`, `nack`+экспоненциальный backoff, переход в `dead_letter`).
Зависимость `better-sqlite3`.

**Не входит.** Postgres, распределённые локи.

**Артефакты.** `src/store/sqlite-store.ts`, `src/store/sqlite-queue.ts`, `src/store/migrations.ts`,
`tests/store.test.ts`.

**Критерии приёмки (тесты).**
- Двойной `enqueue` одного `ReviewKey` → один job (`"duplicate"`).
- `claimReview` второй раз на тот же ключ → `"duplicate"`.
- Истёкший lease → job снова доступен `lease`; `attempts` растёт.
- `nack` × `maxAttempts` → `dead_letter`.
- `seenDelivery` после `markDelivery` → `true`.

**Зависимости.** M0.  **Оценка.** M

---

## M2 — GitHub Gateway  ✅

**Статус.** Готово (зелёное, 12 тестов): HMAC-verify (constant-time) + event-extract/filter; `gitDiff`
(full + incremental, проверен на реальном temp-git); идемпотентный publish по marker (mock Octokit).
Octokit-адаптеры ([`app.ts`](../src/github/app.ts): App-auth, pulls, issue-comments) реализованы за
портами; live checkout/auth — отдельный ручной интеграционный прогон на реальном PR (нужны креды).
Артефакты: [`src/github/`](../src/github) (`webhook`, `git`, `ports`, `publish`, `gateway`, `app`).

**Цель.** Auth + чтение PR + checkout/diff + идемпотентная публикация одного комментария.

**Ценность.** Единственная точка интеграции с GitHub; остальная система от него изолирована.

**Входит.** GitHub App auth (installation token), фабрика Octokit; `GithubWebhookVerifier.verify`
(HMAC-SHA256, constant-time); `getPullRequest`/`listOpenPullRequests`; `checkout` (shallow worktree);
`diff` (full + incremental `fromSha→toSha`, классификация `ChangedFile`); `SingleCommentPublisher.upsertReviewComment`
(найти свой комментарий по marker → edit, иначе create). Зависимости `octokit`, `@octokit/auth-app`.

**Не входит.** Formal review (запрещён продуктово), inline-комментарии.

**Артефакты.** `src/github/app.ts`, `src/github/webhook.ts`, `src/github/gateway.ts`, `src/github/publish.ts`,
`tests/webhook-hmac.test.ts`, `tests/publish-idempotency.test.ts` (Octokit замокан).

**Критерии приёмки.**
- Плохая подпись → `verify` = `false`; валидная → `true`.
- На реальном тест-PR: `checkout`+`diff` корректны; incremental diff между двумя SHA — только новый диапазон.
- Двойной `upsertReviewComment` на один `head_sha` → один комментарий (второй вызов = edit).

**Зависимости.** M0.  **Оценка.** L

---

## M3 — Context Plane (pack load + routing)  ✅

**Статус.** Готово (зелёное, 7 тестов): glob-матчер (`**`/`*`/литералы), `loadPack` (валидация zod +
cross-check route→profile + парсинг subsystem-markdown), `resolveContext` (аддитивный union профилей,
docs/tests, subsystems по path-prefix, invariants по `appliesTo`, security baseline всегда). Артефакты:
[`src/context/`](../src/context) (`pack`, `routing`, `provider`), [`tests/routing.test.ts`](../tests/routing.test.ts).
Подтвердилось на kourion: `metadata/index.ts` активирует и `metadata-token-identity`, и `architecture-boundaries`.

**Цель.** Загрузка/валидация context pack и выборка среза по touched files.

**Ценность.** Context-aware ревью при минимуме токенов; pack пока пишется руками (генерация — M8).

**Входит.** `FsContextProvider.getPack` (читает `context-pack/`, валидирует zod, сверяет sha256 манифеста);
`resolve` (routing globs → **union активных профилей** всех совпавших routes + их `docs`/`tests` +
релевантные invariants + security baseline всегда); excerpt-логика repo-guide под бюджет.

**Не входит.** Генерация pack, ingest существующих доков (это M8).

**Артефакты.** `src/context/provider.ts`, `src/context/routing.ts`, `tests/routing.test.ts`
(фикстура — `config/repos/_example/context-pack`).

**Критерии приёмки** (на kourion-фикстуре `config/repos/_example`).
- `api/src/services/metadata/**` → активные профили `metadata-token-identity` + `security-baseline` (mandatory); грузятся их `docs` + `tests`.
- PR, задевший и `api/src/routes/share.ts`, и `web/src/components/share/**` → **union** профилей совпавших routes (`share-privacy` + `frontend-surface`), без дублей.
- security baseline присутствует **всегда**, даже когда ни один route не совпал.
- Невалидный/рассогласованный pack → понятная ошибка (`ConfigError`).

**Зависимости.** M0.  **Оценка.** M

---

## M4 — Runner Plane (Claude CLI runner, default)  ✅

**Статус.** Готово (зелёное, 7 тестов). Дефолтный runner — **`ClaudeCliRunner`** поверх `claude -p
--output-format json` (агентный, cwd = чекаут, на подписке пользователя, без API-ключа); `AnthropicApiRunner`
оставлен опциональной альтернативой (stub). Тестируется на **замоканном `CliExecutor`** — без реальных
вызовов `claude`. Артефакты: [`src/runners/`](../src/runners) (`registry`, `cli/{executor,claude}`,
`shared/{prompt,output}`, `api/anthropic`), [`tests/runner.test.ts`](../tests/runner.test.ts).

**Цель.** Абстракция `Runner` реально работает с одним backend — CLI-runner на подписке.

**Входит.** `DefaultRunnerRegistry` (select по `RunnerSelector`); `ClaudeCliRunner.review` (сборка промпта
→ спавн `claude -p` → парсинг JSON-конверта → `ReviewResult`); `shared/prompt` (детерминированная сборка
из `ReviewInput`) + `shared/output` (устойчивый `extractJson` + маппинг usage/cost в `meta`); `cli/executor`
(инъектируемый `CliExecutor` для тестируемости).

**Не входит.** Реальный прогон `claude` (это M5), policy по cost/quality (M9), реализация API-runner’а.

**Критерии приёмки.**
- `ReviewInput` с маленьким diff → `ReviewResult` `status:"ok"`, непустой `comment`, `reviewedHeadSha === headSha`, заполнен `meta` (tokens/usd из конверта).
- Парсер извлекает JSON даже при тексте/фенсах вокруг; при мусоре → `status:"error"` `retriable`.

**Зависимости.** M0.  **Оценка.** M

---

## M5 — Worker: первый end-to-end срез  ⭐  ✅

**Статус.** Готово (зелёное, 10 тестов: 6 pipeline + 4 gate/policy). Сквозной `reviewPipeline`
(PR meta → dedupe → workspace+diff → gate → resolve → runner → publish один комментарий → record →
cleanup) — на фейках + реальный SqliteStore. CLI `review <repo> <pr>` c `--dry-run`/`--local`/`--head`
(offline-путь: `ManualPullSource` + non-destructive `git worktree`). Composition root
[`src/compose.ts`](../src/compose.ts). kourion-пак скопирован в `config/repos/NickShtefan__kourion.fi/`.
Артефакты: [`src/apps/worker/`](../src/apps/worker) (`pipeline`,`gate`,`policy`,`workspace`,`loop`),
`src/compose.ts`, [`src/apps/cli/main.ts`](../src/apps/cli/main.ts), `src/github/{manual,worktree}`.
**Реальный прогон `claude -p` ещё не запускался** — ждёт явного согласия (тратит подписку).

**Цель.** Первое реальное ревью; триггер вручную через CLI. **Система оживает.**

**Ценность.** Сквозной путь lease→gate→resolve→checkout/diff→runner→publish→record доказан на одном репо.

**Входит.** Worker-петля (`src/apps/worker`), реализация `Policy.gate` (skip на lockfile/docs/empty/whitespace),
`Policy.selectRunner` (по `repo.yaml`), сборка `ReviewInput` + бюджет, вызов runner, публикация, `recordRun`;
CLI `review <owner/repo> <pr>` (создаёт `manual`-job напрямую в очередь).

**Не входит.** Webhook, reconciler, incremental-оптимизации (full diff ок на этом шаге).

**Артефакты.** `src/apps/worker/loop.ts`, `src/core/policy-impl.ts`, `src/apps/cli` (команда `review`).

**Критерии приёмки.**
- `npm run cli -- review owner/repo 123` на реальном PR → один top-level комментарий с reviewed SHA в теле.
- Повторный запуск того же SHA → `claimReview` = `duplicate`, второго ревью/комментария нет.
- Запись в `review_runs` с токенами и стоимостью.

**Зависимости.** M1, M2, M3, M4.  **Оценка.** M

---

## M6 — Ingress (webhook)  ✅  ⭐ headline-фича

**Статус.** Готово (зелёное, 7 тестов + живой HTTP-смоук: health/ping/bad-sig/filter). `handleWebhook`
(verify HMAC → dedup delivery → filter action/draft/repo → enqueue) + HTTP-сервер (single-process:
приём + coalescing-drain + on-start catch-up reconcile). Merge-base фикс диффа (чистые авто-ревью).
Доставка — **Cloudflare Tunnel** → локальный ingress; гайд [docs/EVENT-DRIVEN.md](EVENT-DRIVEN.md).
Артефакты: [`src/apps/ingress/`](../src/apps/ingress) (`server`, `main`), `git mergeBaseSafe`.

**Цель.** Событийность — авто-триггер в момент PR-события (основной механизм; reconciler — страховка).

**Ценность.** Ревью появляется через секунды после push.

**Входит.** HTTP-сервер (`src/apps/ingress`), маршрут webhook, HMAC-проверка, фильтр `action`/`draft`,
delivery-dedupe (`seenDelivery`), нормализация события → `Job`, `enqueue`, мгновенный 2xx; гайд по туннелю
(cloudflared/ngrok) в README.

**Не входит.** Always-on cloud ingress (Phase 3).

**Артефакты.** `src/apps/ingress/server.ts`, `src/core/events/normalize.ts`, `tests/ingress-filter.test.ts`.

**Критерии приёмки.**
- Push в реальный PR → job → ревью в течение секунд.
- Редоставка того же `delivery_id` → проигнорирована.
- `draft` PR и нерелевантные `action` → 204, без job.

**Зависимости.** M5.  **Оценка.** M

---

## M7 — Reconciler (гарантия полноты)  ⭐ «MVP»  ✅

**Статус.** Готово (зелёное, 3 теста + `isReviewed`). `reconcile()` — sweep открытых non-draft PR по
`enabled`-репо → фильтр `store.isReviewed` → enqueue непокрытых SHA → drain. Sweep **metadata-only**
(0 модельных токенов до находки). CLI `reconcile-now [--dry-run] [--enqueue-only]`; стендалон
`npm run reconciler` — on-start + каждые N часов. `composePlatform` — общая инфра + per-repo deps.
Артефакты: [`src/apps/reconciler/`](../src/apps/reconciler) (`reconcile`, `main`), `compose.ts`
(`composePlatform`), `src/store` (`isReviewed`).

**Цель.** Доганять пропущенное, восстанавливать застрявшее — независимо от webhook.

**Ценность.** Корректность перестаёт зависеть от always-on. Закрывает «машина спала неделю».

**Входит.** `src/apps/reconciler`: sweep открытых non-draft PR по `enabled` репо (list + `head_sha`,
ETag/`updated_at`), enqueue непокрытых SHA, recovery (`error`/протухший lease → re-enqueue с backoff);
расслабленный планировщик (on-start + каждые `everyHours`); CLI `reconcile-now`.

**Не входит.** Распределённый scheduler.

**Артефакты.** `src/apps/reconciler/sweep.ts`, `src/apps/reconciler/schedule.ts`, `src/apps/cli` (`reconcile-now`).

**Критерии приёмки.**
- При выключенном ingress: создать PR → `reconcile-now` → ревью появляется.
- Уже отревьюенные SHA не триггерят повторов.
- До находки непокрытого SHA — ноль модельных токенов (только GitHub metadata).

**Зависимости.** M5 (тот же путь обработки).  **Оценка.** M

---

## M8 — Onboarding pipeline  ✅

**Статус.** Готово (зелёное, 72 теста: +8 onboarding). Pipeline `OnboardingPipeline.run`:
**acquire** (`--local` напрямую / clone default-ветки) → **inventory** (детерминированно, без модели:
языки/фреймворки/PM/CI/тест-команда/entrypoints/модули) → **discover** (README, CLAUDE.md, иерархия
AGENTS.md, `docs/reviewer/`, `docs/invariants/`, ADR) → **assess** (рубрика per-artifact →
`ContextAssessment`) → **decide** (ingest/augment/generate по порогу) → **generate** (через `PackGenerator`
на `claude -p`, только структурные артефакты) → **human-gate** (сгенерированные invariants →
`needs_confirmation`) → **persist** (`writePack` + manifest sha256 + provenance, авто-`repo.yaml`).
**Ingest без модели:** корневой AGENTS.md/CLAUDE.md → repo-guide, вложенные AGENTS.md → subsystems,
`comment-template.md` verbatim. **Платформенные дефолты без модели:** security-baseline,
comment-template. **Генерируются:** routing (additive), profiles, invariants. Re-onboarding идемпотентно:
bump `version`, сохраняет `confirmed` invariants. `reconcileRoutingProfiles` гарантирует валидность под
`loadPack`. CLI: `onboard <owner/repo> [--local <path>] [--threshold <n>] [--confirm-invariants]
[--model <id>] [--dry-run]`. Артефакты: [`src/context/`](../src/context) (`inventory`, `discover`,
`assess`, `onboarding`, `pack.writePack`), [`src/runners/cli/onboard.ts`](../src/runners/cli/onboard.ts)
(`ClaudeCliPackGenerator`), `compose.ts` (`composeOnboarding`), `src/apps/cli` (`onboard`).

**Доказано вживую (2026-06-22, kourion `--local --dry-run`, ~136k tok ≈ $0.50):** inventory верный
(ts/sql/js, express/prisma/react/vite, vitest, модули api/infra=high); discover нашёл все 20 доков
(корневой + 5 вложенных AGENTS.md, `docs/reviewer/` + 8 профилей, 3 `docs/invariants/`); решения
ingest(repo-guide/subsystems/comment-template) / augment(routing/profiles) / generate(invariants);
сгенерированы **10 invariants** (`needs_confirmation`), почти 1:1 совпавшие с ручным `_example`
(token-identity, metadata-seam, snapshot-integrity, public-share masking, owner/public split,
scanner-idempotency, tma-cookies, analytics-noop, schema-migration). Re-onboarding корректно поднял
`context-pack@v2` (есть v1 из M7); `--dry-run` ничего не перезаписал.

**Цель.** Автогенерация context pack вместо ручного написания.

**Ценность.** Масштабирование на много репо; «repo onboarding» из требований.

**Входит.** Onboarding job-тип; **inventory** (языки/фреймворки/CI/тесты/модули); **discover** (repo-доки:
README, CLAUDE.md, AGENTS.md, docs, ADR); **assess** (рубрика per-artifact, `ContextAssessment`);
**generate** (через Runner — repo-guide, subsystems, routing, profiles, *proposed* invariants, security
baseline, comment-template, risk-map); **persist** + `OnboardingResult`; CLI `onboard <owner/repo>` с
human-confirm gate для invariants; запись `provenance`.

**Не входит.** Авто-рефреш при дрейфе кода (Phase 4).

**Артефакты.** `src/context/onboarding/{inventory,discover,assess,generate,persist}.ts`, `src/apps/cli` (`onboard`).

**Критерии приёмки.**
- `onboard` на новом репо → валидный `context-pack@v1` + `OnboardingResult` (status/decisions/provenance).
- Репо с хорошим `CLAUDE.md` → часть артефактов `ingested`.
- Invariants помечены `needs_confirmation` до подтверждения.

**Зависимости.** M3 (формат pack), M4 (runner для генерации).  **Оценка.** L

---

## M9 — Cost & polish

**Частично сделано (вне очереди).**
- **Второй runner** — `CodexCliRunner` (`codex exec --json` на подписке ChatGPT): review **и** onboarding
  (`CodexPackGenerator`), тот же промпт/output-contract, что у Claude; выбор движка через CLI
  `--runner codex-cli` (review + onboard) или `repo.yaml runner.default`; воркер не тронут. Парсер
  `parseCodexEvents` (последний `agent_message` + usage), `sanitizedCodexEnv` (форсит подписку).
  Артефакты: [`src/runners/cli/codex.ts`](../src/runners/cli/codex.ts), [`src/runners/cli/onboard.ts`](../src/runners/cli/onboard.ts), [`tests/codex-runner.test.ts`](../tests/codex-runner.test.ts).
- **CLI `inspect`** — аудит истории ревью: `inspect` (rollup по репо: runs, ok/err/skip, токены, $) и
  `inspect <owner/repo> [--limit N]` (последние раны). Read-only, без GitHub-токена; данные из `recordRun`.
  Методы `SqliteStore.listRuns`/`aggregateByRepo`. Артефакты: [`src/store/sqlite-store.ts`](../src/store/sqlite-store.ts),
  [`src/apps/cli/main.ts`](../src/apps/cli/main.ts), [`tests/inspect.test.ts`](../tests/inspect.test.ts).
- **Incremental diff** — `lastReviewedSha → head`, с **fallback на force-push/rebase**: если прошлый SHA
  пропал или больше не предок head, откатывается на full-diff от базы (`effectiveFrom` + git
  `commitExists`/`isAncestor`). **Ручные** runner-overrides по size/risk/changeType уже применяются
  (`selectRunnerSelector`). Артефакты: [`src/apps/worker/workspace.ts`](../src/apps/worker/workspace.ts),
  [`src/github/git.ts`](../src/github/git.ts), [`tests/incremental-fallback.test.ts`](../tests/incremental-fallback.test.ts).
- **Запуск тестов в worktree (opt-in)** — флаг `review.runTests` (default off). Когда включён И активный
  профиль просит `runTests`: платформа ставит зависимости (`NodeDependencyInstaller`, monorepo-aware:
  root + `api/`/`web/` по lockfile, переиспользует node_modules, bounded), а раннер получает shell
  (`Bash` у Claude / `--sandbox workspace-write` у Codex) через `RunContext.runTests`. Best-effort:
  сбой install → тесты «not run», ревью продолжается. Артефакты: [`src/apps/worker/install.ts`](../src/apps/worker/install.ts),
  [`src/apps/worker/pipeline.ts`](../src/apps/worker/pipeline.ts), [`tests/install.test.ts`](../tests/install.test.ts).

**Осталось в M9:** size-aware лимиты turns; cost-cap; сужение routing; единая шкала severity для Codex;
prompt caching; tiered **авто**-выбор раннера по policy (низкий приоритет: обе CLI-подписки $0, ручных
overrides хватает). Это «хвост» — низкой ценности для подписочной модели; M9 фактически закрыт по сути.

**Цель.** Довести экономию токенов и операбельность.

**Ценность.** Минимизация стоимости (явное требование) + второй runner и видимость costs.

**Входит.** Incremental diff (`lastReviewedSha→head`, fallback на force-push); tiered runner-policy
(cost/size/risk overrides из `repo.yaml`, полноценный `select`); prompt caching (ключ `repo+packVersion+profile`);
расширенный gating (path-фильтры, whitespace); CLI `inspect`/`audit` (история run’ов, cost per repo);
второй runner — CLI-backend (напр. `claude-code`) для глубины.

**Артефакты.** `src/runners/cli/claude-code.ts`, `src/core/policy-impl.ts` (расширение), `src/runners/shared/cache.ts`,
`src/apps/cli` (`inspect`).

**Критерии приёмки.**
- На итеративном PR второй push ревьюит только новый диапазон.
- Маленький low-risk diff уходит на дешёвый runner согласно policy.
- `inspect` показывает токены/стоимость по репо.
- Добавление CLI-runner не трогает worker (только реестр).

**Зависимости.** M5 (и далее).  **Оценка.** L

---

## Порядок сборки

1. **M1, M2, M3, M4** — параллельно (независимы, каждый со своими тестами).
2. **M5** — интеграция → walking skeleton.
3. **M6** и **M7** — латентность и полнота (можно параллельно; M7 важнее для автономности).
4. **M8** — автоматизация онбординга (можно вынести сразу после M5, если приоритет — новые репо).
5. **M9** — экономия и операбельность.

**MVP готов: M0–M7 (incl. M6 event-driven)** — доказан вживую на kourion#330. Осталось из плана:
**M8 (onboarding)** — автоподключение новых репо (вместо ручного pack), и **M9-доводка**
(cost: size-aware max-turns, `npm install` в worktree для тестов, cost-cap, сужение routing).
