import type { Jev, JevQuestion, JevQuestions, JevRequest, JevResult } from '../types'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_TIMEOUT_MS = 4000
// Safety margin under a calling hook's 10 s budget.
const MAX_TIMEOUT_MS = 9000

const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: 'Check TYPESAFE_API_KEY and account access.',
  403: 'Check TYPESAFE_API_KEY and account access.',
  422: "Check question criteria and the model's token limits.",
  429: 'Rate limited or overloaded. Wait before retrying.',
  529: 'Rate limited or overloaded. Wait before retrying.',
}

/** What the noun runs on, narrowed so tests can hand in fakes. */
export type JevDeps = {
  /** The key and model as configured: plugin option first, then the environment. */
  config: () => Promise<{ apiKey?: string; model?: string }>
  fetch: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<{ ok: boolean; status: number; text: string }>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  now: () => number
}

export function jevOf(deps: JevDeps): Jev {
  return {
    async ask<Q extends JevQuestions>(request: JevRequest<Q>): Promise<JevResult<Q>> {
      checkRequest(request)

      const { apiKey, model: configured } = await deps.config()
      const key = apiKey?.trim()
      if (!key) {
        throw new Error('$.jev: no TypeSafe key. Set it in /plugin → jev → Configure options, or TYPESAFE_API_KEY.')
      }
      // A newline or smart quote from copy-paste breaks the header; say so before sending.
      if (!/^[\x21-\x7e]+$/.test(key)) {
        throw new Error('$.jev: the TypeSafe key has characters an HTTP header cannot carry. Re-copy it as plain ASCII.')
      }

      const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS)
      const started = deps.now()
      let payload: string
      try {
        payload = JSON.stringify({
          model: request.model || configured?.trim() || 'jev-latest',
          state: request.state,
          questions: request.questions,
        })
      } catch {
        // A circular value or a throwing toJSON names fields or values; never repeat it.
        throw new Error('$.jev: the request could not be serialized to JSON.')
      }
      // Wrapped so a synchronous throw takes the same sanitized path as a rejection.
      const sent = Promise.resolve().then(() =>
        deps.fetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: payload,
        }),
      )
      // Nothing cancels the request itself; a late failure must not surface unhandled.
      sent.catch(() => {})

      let timer: { cancel: () => void } | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = deps.after(timeoutMs, () =>
          reject(new Error(`$.jev: TypeSafe did not answer within ${timeoutMs} ms. No retry was made.`)),
        )
      })

      let response: Awaited<typeof sent>
      try {
        response = await Promise.race([sent, deadline])
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('$.jev:')) throw error
        // The host's own error may echo request details; keep it out of the message.
        throw new Error('$.jev: could not reach TypeSafe. No retry was made.')
      } finally {
        timer?.cancel()
      }

      if (!response.ok) {
        // The body can echo the state or a secret, so only the status is reported.
        throw new Error(
          `$.jev: TypeSafe answered HTTP ${response.status}. ${STATUS_HINTS[response.status] ?? ''}`.trim(),
        )
      }

      const body = parse(response.text)
      if (
        !isRecord(body) ||
        typeof body.model !== 'string' ||
        !isRecord(body.answers) ||
        !isRecord(body.usage) ||
        !isCount(body.usage.input_tokens) ||
        !isCount(body.usage.output_tokens)
      ) {
        throw new Error('$.jev: TypeSafe returned an invalid response envelope.')
      }
      for (const [id, question] of Object.entries(request.questions)) {
        if (!fits(question, body.answers[id])) {
          throw new Error(`$.jev: TypeSafe returned an invalid or missing answer for ${JSON.stringify(id)}.`)
        }
      }

      return {
        model: body.model,
        answers: body.answers as JevResult<Q>['answers'],
        usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens },
        elapsedMs: deps.now() - started,
      }
    },
  }
}

/** Catches the mistakes TypeSafe would bounce with a 422, before spending a request. */
// Messages name the field at fault, never its value: values are the caller's evidence.
function checkRequest(request: JevRequest): void {
  if (!isText(request.state)) throw new Error('$.jev: state must be non-empty text, a record or a list.')
  const entries = Object.entries(isRecord(request.questions) ? request.questions : {})
  if (entries.length === 0) throw new Error('$.jev: ask at least one question.')
  for (const [id, raw] of entries) {
    const where = `$.jev: question ${JSON.stringify(id)}`
    // Typed callers always pass an object; untyped JS callers may not.
    const q = raw as unknown as Record<string, unknown> | null
    if (!isRecord(q)) throw new Error(`${where} must be an object.`)
    if (!isText(q.instructions)) throw new Error(`${where} needs non-empty instructions.`)
    if (q.type === 'choice') {
      const options = isRecord(q.criteria) ? Object.values(q.criteria) : []
      if (options.length < 2 || options.length > 255) {
        throw new Error(`${where} needs 2 to 255 choice options, got ${options.length}.`)
      }
      if (!options.every((o) => o === null || isText(o))) {
        throw new Error(`${where} has a choice option that is empty; give text or null.`)
      }
    } else if (q.type === 'score') {
      const levels = Array.isArray(q.criteria) ? q.criteria : []
      if (levels.length < 2 || levels.length > 10) {
        throw new Error(`${where} needs 2 to 10 score levels, got ${levels.length}.`)
      }
      if (!levels.every(isText)) throw new Error(`${where} has an empty score level.`)
    } else if (q.type === 'noul') {
      const c = q.criteria
      if (c !== undefined) {
        const sides = isRecord(c) ? Object.keys(c) : []
        const ok =
          isRecord(c) &&
          sides.length > 0 &&
          sides.every((k) => (k === 'true' || k === 'false') && isText(c[k]))
        if (!ok) throw new Error(`${where} noul criteria must be { true?, false? } with non-empty text.`)
      }
    } else {
      throw new Error(`${where} has an unknown type; use choice, noul or score.`)
    }
  }
}

/** Jev's description shape: a non-empty string, record or list. */
function isText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return isRecord(value) && Object.keys(value).length > 0
}

/** Whether an answer has the exact shape its question allows. */
function fits(question: JevQuestion, answer: unknown): boolean {
  if (!isRecord(answer) || answer.type !== question.type) return false
  if (question.type === 'noul') return isProbability(answer.noul)

  const keys = Object.keys(question.criteria)
  if (!isProbability(answer.confidence) || !isDistribution(answer.probabilities, keys)) return false
  if (question.type === 'choice') return typeof answer.choice === 'string' && keys.includes(answer.choice)

  return (
    typeof answer.score === 'number' &&
    answer.score >= 0 &&
    answer.score <= keys.length - 1 &&
    isRecord(answer.legend) &&
    Object.keys(answer.legend).length === keys.length &&
    keys.every((k) => isText((answer.legend as Record<string, unknown>)[k]))
  )
}

function isDistribution(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false
  const got = Object.keys(value)
  return got.length === keys.length && keys.every((k) => isProbability(value[k]))
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
