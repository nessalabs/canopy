/** @responsibility Narrows values decoded from a wire, where the compiler's types have already been erased. */

/**
 * A value as it arrives from `JSON.parse`.
 *
 * Shared rather than provider-scoped: every wire this library reads is JSON,
 * and the readers below are how a provider module gets from a decoded blob to
 * its own declared shapes.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * Why these exist at all.
 *
 * Everything past `JSON.parse` is `unknown` at runtime — TypeScript's types are
 * erased, so a declared shape is a *claim* about the bytes, not a check on
 * them. There are exactly three ways to bridge that: assert and hope, validate
 * with a schema library, or narrow. Asserting turns one malformed line into a
 * crash somewhere far away; a schema library performs these same checks with a
 * dependency and a per-line cost on the hottest path in the parser.
 *
 * So: narrow — but narrow *once*, here, behind names. Scattering `typeof`
 * through the mapper is the thing worth objecting to; a handful of named
 * readers used consistently is not. Each returns `null` for "not that shape",
 * so a caller uses `??` to state its fallback rather than branching.
 */

/** What a line that could not be decoded at all becomes. */
export interface JsonLineFailure {
  readonly ok: false
  readonly line: string
  readonly reason: string
}

export interface JsonLineSuccess {
  readonly ok: true
  /** An object with a string `type` — the most any decoder can claim before reading further. */
  readonly line: { readonly type: string; readonly [key: string]: JsonValue | undefined }
}

export type JsonLineResult = JsonLineSuccess | JsonLineFailure

/**
 * Decodes one line of a newline-delimited JSON stream.
 *
 * Shared by every provider because every provider's wire is this: a stream is
 * read for as long as a process runs, and one malformed line — a truncated
 * write, a stray log — must not end the transcript, so failure is returned
 * rather than thrown. Blank lines fail with an explicit reason so a caller
 * filters them knowingly rather than by accident.
 */
export function parseJsonLine(text: string): JsonLineResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, line: text, reason: "empty line" }

  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, line: text, reason: error instanceof Error ? error.message : "invalid JSON" }
  }

  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, line: text, reason: "line is not a JSON object" }
  }
  if (typeof (decoded as { type?: unknown }).type !== "string") {
    return { ok: false, line: text, reason: "line has no `type`" }
  }
  return { ok: true, line: decoded as JsonLineSuccess["line"] }
}

/**
 * The same, for a wire that does not tag its lines with a `type`.
 *
 * Three of the four wires here are streams of type-tagged events, and their
 * mappers rely on `parseJsonLine` having checked that. JSON-RPC is not one of
 * those: a frame is identified by `method`, `id` and `result`, so requiring a
 * `type` would reject every valid frame. The object check is the whole of what
 * can honestly be promised about one.
 */
export function parseJsonObjectLine(text: string): JsonLineResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, line: text, reason: "empty line" }

  let decoded: unknown
  try {
    decoded = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, line: text, reason: error instanceof Error ? error.message : "invalid JSON" }
  }

  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { ok: false, line: text, reason: "line is not a JSON object" }
  }
  return { ok: true, line: decoded as JsonLineSuccess["line"] }
}

/** Decodes a whole capture, keeping failures in place. */
export function parseJsonLines(text: string): readonly JsonLineResult[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseJsonLine)
}

/** Trims a path to its last two segments, which is what identifies a file in a narrow row. */
export function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`
}

/** The value as a string, or null. */
export function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null
}

/** The value as a finite number, or null. Rejects NaN, which JSON cannot carry but a producer can still imply. */
export function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** The value as a boolean, or null — distinct from `false`, which some flags mean. */
export function asBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null
}

/**
 * The value as a plain object, or an empty one.
 *
 * Empty rather than null because every caller wants to read a field from it and
 * `{}` reads a missing field as missing — the same answer an absent object
 * should give.
 */
export function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, JsonValue>
}

/**
 * The value as an object, or null when it is anything else — including absent.
 *
 * The strict counterpart of [`asRecord`]: use this where "no object here" and
 * "an object with nothing in it" must stay different answers. Usage is the
 * case that matters — an absent block means the line reported nothing, and
 * flattening it to `{}` turns every counter into a confident zero.
 */
export function asObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, JsonValue>
}

/** The value as an array, or an empty one, for the same reason. */
export function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}

/** The value as an array of strings, dropping anything that is not one. */
export function asStrings(value: JsonValue | undefined): readonly string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string")
}

/**
 * The value if it is one of `allowed`, else null.
 *
 * The bridge from a wire's open vocabulary to a closed union: a status the
 * provider invents tomorrow is rejected here rather than widening a field the
 * rest of the code has already promised is one of a few things.
 */
export function asOneOf<T extends string>(
  value: JsonValue | undefined,
  allowed: readonly T[],
): T | null {
  const text = asString(value)
  return text !== null && (allowed as readonly string[]).includes(text) ? (text as T) : null
}
