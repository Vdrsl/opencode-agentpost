export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogSetting = "off" | "info" | "debug"
export type LogFields = Readonly<Record<string, number | boolean>>
export type Logger = (level: LogLevel, event: string, fields?: LogFields) => void

export type LoggerOptions = {
  env?: Readonly<Record<string, string | undefined>>
  write?: (line: string) => void
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const FIELD_NAMES = new Set([
  "ageMs",
  "alive",
  "attempt",
  "count",
  "defers",
  "durationMs",
  "removed",
  "status",
])

export const noopLogger: Logger = () => {}

export function resolveLogLevel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LogSetting {
  const explicit = env["AGENTPOST_LOG_LEVEL"]?.trim().toLowerCase()
  if (explicit === "off" || explicit === "info" || explicit === "debug") return explicit
  if (explicit !== undefined) return "off"
  const debug = env["AGENTPOST_DEBUG"]?.trim().toLowerCase()
  return debug === "1" || debug === "true" || debug === "yes" || debug === "on" ? "info" : "off"
}

function safeEvent(event: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(event) ? event : "invalid_event"
}

function safeFields(fields: LogFields | undefined): Record<string, number | boolean> {
  const result: Record<string, number | boolean> = {}
  if (!fields) return result
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_NAMES.has(key)) continue
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      result[key] = value
    }
  }
  return result
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const setting = resolveLogLevel(options.env)
  const threshold = setting === "off" ? Number.POSITIVE_INFINITY : RANK[setting]
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  return (level, event, fields) => {
    if (RANK[level] < threshold) return
    const record = {
      at: new Date().toISOString(),
      level,
      event: safeEvent(event),
      ...safeFields(fields),
    }
    write(`${JSON.stringify(record)}\n`)
  }
}
