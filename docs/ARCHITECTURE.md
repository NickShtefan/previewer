# Архитектура: previewer

Универсальный автономный **AI PR review orchestrator** для множества репозиториев.
Документ описывает продукт, а не настройку одного репо. Он — источник истины по архитектуре;
форматы данных формально заданы zod-схемами в [`src/config/schema`](../src/config/schema).

---

## 0. Две опорные идеи

**(1) Webhook — это оптимизация latency. Reconciler — это гарантия полноты.**
Webhook нужен, чтобы ревью появилось через секунды, *когда agent-machine включена*. Источником
истины «что уже отревьюено» он не является. [Reconciler](#13-reconciler) периодически сверяет
открытые PR со state store и доганяет всё, что webhook пропустил (машина спала неделю, событие
потерялось, был force-push в даунтайме). Следствие: **дорогая always-on инфраструктура ради
надёжности не нужна** — нужен дешёвый буфер ради скорости, а корректность держит reconciler.
Это идеально ложится на нерегулярный режим работы.

**(2) Платформе принадлежат orchestration, context, dedupe, policy, publishing. Модель — сменный `Runner`.**
Вся логика — у платформы. Модельный backend (Codex/Claude/Gemini CLI, Anthropic/OpenAI/Google API)
скрыт за контрактом [`Runner`](#10-runner-контракт-cli-vs-api). Добавить backend = добавить адаптер,
ноль изменений в worker/queue/publish.

---

## 1. Runtime-поток

```
                 ┌─────────────────────────── always-on (intake) ───────────────────────────┐
  GitHub ──webhook──▶ Webhook Ingress ─┐                          Reconciler ──poll metadata──▶ GitHub
  PR events          (verify·filter)   │                          (sweep missed SHAs)
                                       ▼                                   │
                              ┌──────────────────┐                         │
                              │  Durable Queue    │◀────── enqueue ────────┘
                              │ jobs·idempotent   │
                              └────────┬─────────┘
                                       │ lease
                                       ▼
   Context Store ──resolve(routing)──▶ Worker ──ReviewInput⇄Result──▶ Runner (CLI | API)
   (per-repo packs)                    │  gate → context → run → publish
                                       ├── publish ──▶ GitHub: 1 top-level comment / head SHA
                                       └── record ───▶ State / Audit DB (dedupe · runs · cost)
```

Шесть логических плоскостей: **Intake** (ingress + reconciler), **Queue/State**, **Worker**,
**Context** (store + onboarding), **Runner** (registry + адаптеры), **Control** (CLI + конфиги).

---

## 2. Решения MVP-упаковки

| Решение | Выбор для MVP | Почему / куда эволюционирует |
|---|---|---|
| Упаковка кода | **single-package TS**, модули в `src/*` | Прагматичнее монорепо для одной agent-machine. Разнести на пакеты — Phase 3, границы уже заданы интерфейсами. |
| Хранилище | **SQLite** (queue + state + audit в одном файле) | Транзакции, UNIQUE = dedupe бесплатно. За `Store`/`Queue` → Postgres позже. |
| Формат конфигов | **camelCase в YAML == ключам zod** | zod — единственный источник истины. Snake_case-адаптер тривиально добавить позже. |
| Intake | **reconciler-first + опц. webhook** | Полнота не зависит от always-on. Webhook добавляется как latency-слой (M6). |
| Runner по умолчанию | **API-first**, CLI для глубины | Дёшево и предсказуемо; policy выбирает CLI на крупных/высокориск diff. |

---

## 3. Компоненты и ответственность

| Компонент | Отвечает за | Код |
|---|---|---|
| **Ingress** | HMAC, фильтр события/draft, идемпотентность по `delivery_id`, enqueue, мгновенный 2xx | `src/apps/ingress`, `src/github` |
| **Reconciler** | сверка открытых PR ↔ state, enqueue непокрытых SHA, recovery застрявших job | `src/apps/reconciler` |
| **Queue** | durable jobs, lease/visibility-timeout, retry+backoff, dedupe | `src/store` (`Queue`) |
| **Worker** | оркестрация review-run: gate→context→run→publish→record | `src/apps/worker` |
| **Context Store** | хранение/версии/выборка context pack | `src/context` (`ContextProvider`) |
| **Onboarding** | инвентаризация, поиск/оценка контекста, генерация pack | `src/context` (`OnboardingPipeline`) |
| **Runner registry** | реестр backend’ов, capabilities, policy-выбор | `src/runners`, `src/core/runner.ts` |
| **GitHub gateway** | App-auth, checkout/diff, идемпотентный publish | `src/github` |
| **State/Audit** | dedupe-факты, run-записи, cost | `src/store` (`Store`) |

Принцип: **Worker не знает о конкретной модели; Runner не знает о GitHub и очереди.** Их связывает
только контракт [`ReviewInput`/`ReviewResult`](../src/config/schema/review.ts).

---

## 4. Поток reviewer-run (worker)

```
lease(job)
 ├─ claimReview(repo,pr,head_sha) → "duplicate"? skip
 ├─ GATE (дёшево, без модели): lockfile/docs/whitespace/empty → skip|light
 ├─ resolve context: routing(changedFiles) → срез pack (НЕ весь)
 ├─ checkout + diff (incremental: fromSha = lastReviewedSha)
 ├─ select Runner: policy(repo, changeType, size, risk)
 ├─ build ReviewInput (+ budget)
 ├─ runner.review(input, ctx)             ← единственная дорогая точка
 ├─ publish: upsert ОДИН top-level comment по marker (idempotent)
 ├─ recordRun (audit + cost + финализация dedupe)
 └─ ack(job)   |   error → nack(backoff) → retry / dead_letter
```

Reviewer-run неинтерактивен и конечен: получает контекст, рабочую директорию и инструкции, делает
ревью, завершает работу. Не «вечный чат».

---

## 5. Идемпотентность (4 слоя) — «retries без дублей»

1. **Delivery** — `X-GitHub-Delivery` UUID в таблице `deliveries(UNIQUE)`; редоставка отбрасывается до очереди.
2. **Job** — UNIQUE активная job на `(repo, pr, head_sha)`; lease с timeout; падение → lease истёк → переезд, `attempts++`, backoff; `max_attempts` → `dead_letter`.
3. **Review** — `claimReview` через `INSERT … ON CONFLICT DO NOTHING` на dedupe-ключе.
4. **Publish** — worker мог упасть *после* публикации, но *до* записи state. Поэтому publish ищет наш прошлый комментарий по скрытому маркеру `<!-- ai-review:{repo}#{pr}@{head_sha} -->` и делает **upsert**, а не blind-post.

---

## 6. Dedupe и state

Канонический ключ: `(repo, pr_number, head_sha)` (схема [`ReviewKey`](../src/config/schema/state.ts)),
UNIQUE-индекс в `review_runs`. Гранулярность всегда по SHA: новый push = новый SHA = новый ключ =
новое ревью; force-push/rebase меняет SHA → новый ключ автоматически. Таблица `review_runs` —
одновременно dedupe и audit (runner, model, profile, comment_id, tokens, usd, duration, error, ts).

SQLite-схема (целевая, реализуется в M1):

```sql
CREATE TABLE deliveries  (github_delivery_id TEXT PRIMARY KEY, received_at TEXT);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, repo TEXT, pr_number INT, head_sha TEXT,
  source TEXT, status TEXT, attempts INT DEFAULT 0, locked_at TEXT, created_at TEXT,
  UNIQUE(repo, pr_number, head_sha));
CREATE TABLE review_runs (
  id TEXT PRIMARY KEY, repo TEXT, pr_number INT, head_sha TEXT, base_sha TEXT,
  runner TEXT, model TEXT, profile TEXT, status TEXT, comment_id INT,
  tokens_in INT, tokens_out INT, usd REAL, duration_ms INT,
  error TEXT, started_at TEXT, finished_at TEXT,
  UNIQUE(repo, pr_number, head_sha));
```

---

## 7. Context pack

Версионированный bundle артефактов **платформы** (не хардкод под репо), адресуемый `context-pack@vN`,
с манифестом и хешами. Состав — [`src/config/schema/pack.ts`](../src/config/schema/pack.ts):
repo-guide, subsystem-guides, routing, profiles, invariants, security-baseline, comment-template, risk-map.
Пример: [`config/repos/_example/context-pack`](../config/repos/_example/context-pack).

**Хранение — hybrid:** источник истины у платформы (`config/repos/<repo>/context-pack/`); onboarding
**ингестит** существующий in-repo контекст (`CLAUDE.md`, `AGENTS.md`, `docs/`, ADR …). Это и есть
«артефакты платформы, а не файлы под один проект».

**Выборка (cost-critical):** pack целиком в токены не уходит **никогда**. Worker через `routing.yaml`
выбирает срез: только subsystem-guides затронутых модулей + профиль + релевантные invariants +
security baseline (всегда). См. [`ResolvedContext`](../src/config/schema/review.ts).

---

## 8. use-existing vs generate

Не бинарно, а **рубрика per-artifact / per-subsystem** ([`ContextAssessment`](../src/config/schema/onboarding.ts)):
`coverage`, `specificity`, `freshness`, `security`, `machineUsability` (0..1). Решение на каждый артефакт:

```
score ≥ 0.7  → ingest    (как есть; provenance=ingested)
0.4–0.7      → augment   (существующее + дополнения)
< 0.4 / нет  → generate  (платформой; invariants → needs_confirmation)
```

Каждый артефакт несёт [`Provenance`](../src/config/schema/pack.ts) — источник/модель/confidence/approvedBy.
Репо с хорошим `CLAUDE.md` получает почти весь pack через ingest; слабый — через generate; одна механика.

---

## 9. Onboarding pipeline

Сам по себе — отдельный job-тип, может исполняться агентным CLI-runner’ом с доступом к checkout.
Стадии: **acquire** (shallow-clone) → **inventory** (языки/фреймворки/CI/тесты/модули) →
**discover** (repo-доки) → **assess** (рубрика §8) → **decide** (per-artifact) → **generate** →
**human-gate** (обязателен для invariants и security-additions — галлюцинированный инвариант, который
энфорсится в каждом ревью, дороже отсутствующего) → **persist** + [`OnboardingResult`](../src/config/schema/onboarding.ts).
Идемпотентен и инкрементален: повторный запуск делает diff против прошлого pack и поднимает `version`.

---

## 10. Runner: контракт, CLI vs API

Контракт — [`src/core/runner.ts`](../src/core/runner.ts):

```ts
interface Runner {
  readonly id: string;
  readonly capabilities: RunnerCapabilities;
  review(input: ReviewInput, ctx: RunContext): Promise<ReviewResult>;
  onboard?(input: OnboardingInput, ctx: RunContext): Promise<OnboardingResult>;
}
```

| | CLI runner (Codex, Claude Code, Gemini CLI) | API runner (Anthropic/OpenAI/Google) |
|---|---|---|
| Модель работы | **агентный**: сам читает файлы, гоняет тесты | **stateless**: контекст собирает платформа |
| Workspace | нужен (`needsWorkspace: true`) | не нужен |
| Контроль токенов | косвенный (бюджет на чтения) | **точный** |
| Структурный вывод | через prompt-контракт | native JSON / tool-call |
| Стоимость | выше, менее предсказуема | ниже, предсказуема |
| Сила | большие/незнакомые репо, прогон тестов | дешёвый узкий diff, классификация, gating |

`ReviewInput`/`ReviewResult` (см. [`review.ts`](../src/config/schema/review.ts)) спроектированы так, чтобы
удовлетворять **обоим** профилям. Инвариант: `reviewedHeadSha` всегда эхо-возврат входного `headSha`;
`comment.bodyMarkdown` готов к публикации; `findings` не публикуются — это audit + будущий feedback-loop.

---

## 11. Webhook security

- **GitHub App** (не PAT): least-privilege, per-repo installation, short-lived tokens, подписка только на `pull_request`.
- **HMAC** `X-Hub-Signature-256`, constant-time compare → иначе 401.
- **Fast-path фильтр** до тяжёлой работы: `action ∈ {opened, reopened, synchronize, ready_for_review}`, `draft == false`. Иначе мгновенный 204.
- **Ack-then-work**: проверил → enqueue → 2xx за миллисекунды. Review не висит на HTTP.
- **Идемпотентность** по `delivery_id`. Defense-in-depth: лимит payload, rate-limit, опц. allowlist GitHub IP.
- Секреты (webhook secret, App private key) — в env/secrets-store, никогда в pack/конфиге.

---

## 12. Cost / token reduction

По убыванию эффекта: **(1)** event gating + dedupe по SHA = ноль работы на no-op; **(2)** cheap
pre-check до модели (lockfile/generated/docs/whitespace, path-фильтры, size→глубина); **(3)** incremental
review (diff `lastReviewedSha→head`, fallback на full при force-push); **(4)** context routing (только срез
pack); **(5)** tiered runner/model routing (дёшево на мелком, CLI на крупном/высокориск); **(6)** prompt
caching по ключу `repo+packVersion+profile`; **(7)** risk-aware depth (тесты только когда risk-map велит);
**(8)** budget caps per run (security baseline и invariants режутся последними); **(9)** reconciler работает
на metadata (0 модельных токенов до находки).

---

## 13. Reconciler

Перечисляет открытые non-draft PR по всем `enabled` репо, берёт `head_sha`, сверяет со state; непокрытый
SHA → enqueue (тот же путь, что webhook). Плюс recovery: error-job / протухший lease → re-enqueue с backoff.
**Не 24/7-cron**: триггеры — старт agent-machine, расслабленное расписание (несколько раз в день),
`cli reconcile-now`. Дёшево (ETag/`updated_at`, только open PR). Это и есть гарантия полноты из §0.

---

## 14. Security baseline (обязательный)

Каждое ревью включает security/privacy/risk lens независимо от домена
([`SecurityBaseline`](../src/config/schema/pack.ts)): data leaks, unauthorized access, dangerous external
calls, auth/session regressions, privacy boundary leaks, insecure reads/writes, analytics/data exfiltration,
supply-chain/secret exposure. `severityFloor` не подавляется gating’ом; репо-специфичное — в `extra`.

---

## 15. Эволюция MVP → platform

- **MVP**: одна agent-machine, SQLite, reconciler + опц. webhook, 1–2 runner’а, ручной onboarding. Multi-repo = строки в `config/repos/`.
- **Phase 2**: runner policy-engine, prompt caching, incremental, web-дашборд аудита/costs, авто-onboarding.
- **Phase 3**: always-on cloud ingress + durable cloud queue, горизонтальные worker’ы, Postgres, secrets-manager, опубликованный GitHub App, метрики.
- **Phase 4**: feedback-loop (полезность комментариев), авто-рефреш pack при дрейфе, мульти-тенант.

Граница, которую держим с M0: `Store`, `Queue`, `Runner`, `ContextProvider`, `Publisher`, `GitHubClient` —
интерфейсы. SQLite→Postgres, local→cloud, single→fleet меняются за реализацией, не в worker.

---

## 16. Архитектурные развилки

| Развилка | Выбор MVP | Альтернатива / когда менять |
|---|---|---|
| Intake | reconciler-backed + опц. webhook | cloud-ingress — Phase 3 при росте нагрузки |
| Хранение pack | hybrid (platform + ingest) | in-repo `.review/` если нужен PR-ревью пака |
| Runner по умолчанию | API-first | CLI когда нужна глубина/тесты |
| Review на synchronize | incremental + fallback | full если часты rebase |
| State/Queue | SQLite | Redis/cloud — Phase 3 |
| Генерённые invariants | human-confirm | авто-энфорс только при высоком доверии |

---

## 17. Карта кода

| Слой | Путь | Майлстоун |
|---|---|---|
| Контракты (zod) | `src/config/schema` | M0 ✓ |
| Loader конфигов | `src/config/index.ts` | M0 ✓ |
| Интерфейсы | `src/core` | M0 ✓ |
| Store + Queue | `src/store` | M1 ✅ |
| GitHub gateway | `src/github` | M2 ✅ |
| Context provider | `src/context` (`FsContextProvider`) | M3 ✅ |
| Onboarding (`inventory`/`discover`/`assess`/`OnboardingPipeline`/`writePack`) + `PackGenerator` | `src/context`, `src/runners/cli/onboard.ts` | M8 ✅ |
| Runner registry + CLI runner (`claude -p`) | `src/runners` | M4 ✅ |
| Worker (`reviewPipeline`) + composition root | `src/apps/worker`, `src/compose.ts` | M5 ✅ |
| Ingress (webhook HTTP server) | `src/apps/ingress` | M6 ✅ |
| Reconciler (`reconcile` sweep) + `composePlatform` | `src/apps/reconciler`, `src/compose.ts` | M7 ✅ |
| CLI | `src/apps/cli` | M5/M7/M8/M9 |

---

## 18. Калибровка по kourion.fi (reference)

`~/Projects/CODE/kourion.fi` — рабочий single-repo PoC этой модели. Его слой (`AGENTS.md`-иерархия +
`docs/reviewer/` + `docs/invariants/`) изучен 2026-06-21 и принят за эталон для onboarding-ingest (M8).
Из него в контракты M0 внесены 4 дельты:

1. **Профиль несёт `docs[]` + `tests[]`** (не только depth/focus) — [`ReviewProfile`](../src/config/schema/pack.ts).
2. **Routing аддитивный**: `defaults` (mandatoryProfiles, requiredContext) / `routes` (paths → activateProfiles, **объединяются**) / `notes`. PR активирует UNION профилей всех совпавших routes — [`Routing`/`Route`](../src/config/schema/pack.ts).
3. **Инвариант богаче**: `severity` + `reviewerQuestions` + `body` — [`Invariant`](../src/config/schema/pack.ts).
4. **Честный comment-template**: активные профили + «Tests run / Tests NOT run» + residual risk + «comment only» — [`CommentPublishingPolicy.include`](../src/config/schema/publish.ts) + шаблон в example pack.

Нормализованный срез kourion лежит в [`config/repos/_example`](../config/repos/_example) — это и референс
формата, и фикстура для M3 (routing) и M8 (ingest). Playbook kourion (`docs/reviewer/README.md`)
подтверждает поведение M5–M7: comment-only, один комментарий на head SHA, upsert на rerun,
heartbeat-loop, skip уже-прокомментированного SHA.

---

Подробный план сборки — [`docs/MILESTONES.md`](MILESTONES.md).
