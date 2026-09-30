# Перенос на OpenCode v2

Исследование блокеров миграции. Источники: официальный мигрейшн-гайд
(`opencode.ai/v2/docs/migrate-v1`, `opencode.ai/v2/docs/build/plugins/migrate-v1`),
обзор V2 plugin API и чтение текущего кода репозитория.

## Главный вывод

Архитектурной несовместимости нет. Препятствие — механическое: V1 plugin API
не запускается в V2, и адаптер (entrypoint + hooks + tools + session client)
надо переписать. Ядро (registry, store, inbox, outbox, mesh) почти не
зависит от OpenCode.

## Блокеры по приоритету

### 1. Entrypoint (src/index.ts) — высокая

V1:

```ts
import type { Plugin } from "@opencode-ai/plugin"
export const AgentMesh: Plugin = async (input, options) => {
  // ...
  return { tool, "chat.message", "experimental.chat.system.transform", "event", dispose }
}
```

V2:

```ts
import { Plugin } from "@opencode/plugin"
export default Plugin.define({
  id: "agentmesh",
  async setup(ctx) { /* ... */ },
})
```

V1-реализация в V2 не запускается. Это не смена версии пакета — другой контракт.

### 2. Hooks — высокая (меняется семантика, не только API)

| V1 | V2 |
| --- | --- |
| `"chat.message": async ({ sessionID }) => {}` | `ctx.session.hook("prompt", (event) => {})` |
| `"experimental.chat.system.transform": async ({ sessionID }, output) => { output.system.push(...) }` | `ctx.session.hook("context", (event) => { event.system.push({ type: "text", text }) })` |
| `"event": async ({ event }) => {}` | `ctx.event.subscribe(...)` (async iterable) |
| `dispose` | cleanup-функция, возвращаемая `setup()` |

Важно: `prompt` hook работает до durable prompt admission, `context` — непосредственно
перед model request. Это разные точки, и auto-register надо вешать осознанно.

Форма system prompt: в V1 `output.system` — массив строк. В V2 `event.system` —
массив content parts (`{ type: "text", text }`). Не механический перенос.

### 3. Tools (src/tools.ts) — средняя

V1 возвращает map через `tool()`. V2 регистрирует через transform:

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "agentmesh_send",
    description: "...",
    input: { type: "object", properties: { ... }, required: [...] },
    async execute(input) {
      return { content: JSON.stringify(result, null, 2) }
    },
  })
})
```

- Схема — JSON Schema, не `tool.schema.string()`.
- `execute` возвращает `{ content }`, не строку.
- Пять инструментов (register, peers, send, fetch, deliveries) перенести можно,
  но `buildTools` будет заметно переделан.

### 4. Session client (src/index.ts inject) — средняя

| V1 | V2 |
| --- | --- |
| `input.client.session.get({ path: { id }, query: { directory } })` | `ctx.session.get(...)` |
| `input.client.session.status({ query: { directory } })` | `ctx.session.status(...)` |
| `input.client.session.promptAsync.call(client.session, { path, query, body, signal })` | `ctx.session.prompt({ sessionID, text, delivery })` |

`ctx.session.prompt` с `delivery: "steer" | "queue"` существует (видел в командном
примере мигрейшн-гайда). Семантика admission/execution, обработка ошибок,
таймауты и abort надо сверять с реальным V2 API на целевой версии.

### 5. Контекст / serverUrl — средняя

| V1 | V2 |
| --- | --- |
| `input.directory` | `ctx.location.directory` |
| `input.worktree` | `ctx.location.project.canonical` (или аналог) |
| `input.serverUrl` | ? |

`serverUrl` в V2 plugin API не обнаружен. В коде он прокидывается в `buildTools`
и `SessionContext`, но где реально читается — надо проверить. Если используется
для построения URL в инструментах — блокер.

### 6. Конфигурация — низкая

В `opencode.json(c)`:

```jsonc
// V1
{ "plugin": [["@vdrsl/opencode-agentmesh", { "id": "..." }]] }
// V2
{ "plugins": [{ "package": "@vdrsl/opencode-agentmesh", "options": { "id": "..." } }] }
```

Ключ `plugin` → `plugins`, tuple-форма → object-форма.

### 7. Тесты — высокая

`test/e2e.test.ts` и `test/sdk-probe.test.ts` используют V1 SDK boundary
(fake HTTP server, `client.session.*`). Переписывать под V2.

## Что почти не изменится

```
src/config.ts
src/registry.ts
src/store.ts
src/inbox.ts      ← кроме inject boundary
src/outbox.ts
src/mesh.ts       ← кроме OpenCode session calls
src/ids.ts
src/names.ts
src/envelope.ts
```

## Переоценки в предварительном анализе

1. **«Phase 3.5 может делегироваться V2»** — преувеличение. V2 session inbox
   (steer/queue, SessionRunCoordinator) — внутрипроцессная доставка: планирование
   session inputs внутри одного opencode-сервера. Agentmesh adaptive delivery —
   межпроцессная: watcher забирает из filesystem inbox и инжектит в сессию
   получателя. Разные слои. V2 не устраняет watcher — меняет только механизм
   инжекции. Claiming, batch notification, fetch tool, fallback остаются на
   agentmesh.

2. **«promptAsync → session.prompt — низкая сложность, V2 даже лучше»** — оптимистично.
   Семантика admission/execution, ошибки, таймауты, abort надо сверять с
   реальным V2 API, а не со спекой. Утверждение про SessionRunCoordinator и
   coalescing основано на `specs/v2/session.md` — не проверено.

3. **«ctx.session.wait({ sessionID })»** — в прочитанной доке этого нет. Нужна
   проверка.

4. **Надёжность `session.idle`** — есть сообщения о расхождении между
   объявленными V2 events и реальным event stream. Перед использованием
   idle-event нужен probe на целевой версии V2.

## Рекомендация

Сначала закончить Phase 3.5, потом мигрировать. Миграция — отдельная задача с
непредсказуемым объёмом (hooks + tools + entrypoint + тесты), и смешивать её
с активной разработкой 3.5 — плохая идея.

Перед миграцией сделать probe на целевой версии V2:
- семантика `ctx.session.prompt` (admission/execution, ошибки, таймауты, abort)
- наличие `ctx.session.wait`
- надёжность `ctx.event.subscribe` (включая `session.idle`)
- доступность `serverUrl` в plugin context
