# After Phase 4 — backlog

Идеи для развития после завершения Phase 4. Источники: анализ конкурентов
(`opencode-plugin-peers`, `agent-talk`, `opencode-agent-mesh`) и текущее
состояние репозитория.

## 1. Inbound policy — rejected as a pseudo-boundary

**Предложено было:** политика входящих сообщений (`accept` / `auto` / `hold` /
`refuse`), плюс rate limits и size caps.

**Решение: отклонено, не в бэклог.** Политика внутри mailbox не может быть
границей авторизации, потому что границы нет на носителе: любой процесс с
правом записи в `<home>` пишет `agents/<id>.json`, `inbox/<id>/…`,
`processed/<msgid>.json` и `acks/…` напрямую, минуя любой наш код. Валидация
внутри меша эти файлы не видит. Поэтому политика фильтрует только тех, кто и так
играет по правилам, — наших же пиров. Это не защита, а видимость защиты, и хуже
того, обманчиво.

**Почему и «только от зарегистрированных отправителей» не работает:** чужой
процесс просто дописывает себе `agents/<id>.json` и становится
«зарегистрированным». Пока доверен домашний каталог, любая проверка внутри
меша иллюзорна. Граница — права ОС на `<home>` и ответственность оператора, не
код в `src/`. Полностью и обоснование: `AGENTS.md`, раздел «Security and
limitations».

**Если область выйдет за одну доверенную машину** (чужие пользователи, сеть) —
модель угроз пересобирается с нуля: подписи отправителя, внешняя авторизация,
транспорт с проверкой подлинности. Не почтовый фильтр.

**Полезный остаток уже покрыт:** rate limit и size caps существуют как
`maxInboxMessages` и `maxInboxBytes` — это robustness против наводнения, не
security.

## 2. Runtime adapter (V2)

Подтверждено `agent-talk`: транспорт отделён от runtime-механизма.

```text
AgentMash core
       │
       ├── filesystem transport
       │
       └── OpenCode adapter (V1 / V2)
```

Уже записано в `V2transf.md`. После Phase 4 — отдельная задача миграции.

## 3. Сверка delivery state machine

**Идея (из opencode-plugin-peers):** явная state machine, а не вывод из существования
файла и mtime.

Их: `queued / held / inflight / done`.
Наш: `queued / accepted / failed / ambiguous / undeliverable`.

**Действие:** не копировать, а сверить инварианты — убедиться, что переходы покрывают
все случаи и не создают двусмысленности. Особенно после Phase 3.5.

## 4. File lease coordination

**Идея (из TheRealAlexV/opencode-agent-mesh):** soft/exclusive leases на файловые
пути, чтобы несколько агентов не редактировали один файл конфликтно.

```text
mesh_claim   — взять lease (soft или exclusive)
mesh_release — отпустить
mesh_leases  — список активных
```

**Статус:** backlog. Полезно для сценария «несколько агентов в одном репозитории».
Сейчас два агента могут конфликтовать на одном файле.

## 5. Метрики / счётчики

**Идея (из opencode-agent-hub):** внутренние счётчики вместо тяжёлого Prometheus.

```text
messages_sent
messages_accepted
messages_fetched
messages_fallback_injected
messages_duplicate
messages_undeliverable
delivery_latency
```

**Статус:** backlog. Полезно при реальном прогоне агентов.

## 6. Hop protection

**Идея (из opencode-plugin-peers):** ограничение числа hop'ов через `via` list,
чтобы предотвратить бесконечную пересылку.

```text
message.via?: agentId[]
```

**Статус:** YAGNI. Сейчас `send` не relay'ит сообщения. Добавить, когда появится
forwarding/bridge.

## Не брать

Этот раздел держим при каждом «а давайте добавим демон» — он фиксирует не
только что не берём, но и почему.

- **opencode-agent-hub** (AGPL-3.0, заархивирован 2026-08-30): daemon, SQLite
  polling, coordinator, MCP. Причины архивации (coupling к недокументированным
  internals, быстрый upstream, prompt injection) — валидация текущего
  filesystem-based дизайна agentmesh.
- **UDS/TCP transport, TUI command machinery, slash-command routing** (peers):
  filesystem transport — сознательный выбор.
- **Relay/crypto слой** (agent-talk): пока не нужен. Стратегический запас на случай
  выхода за пределы shared filesystem (LAN/Tailscale/WAN).
