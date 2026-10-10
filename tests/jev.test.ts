import { expect, test } from 'claude-code/testing'

import { jevOf, type JevDeps } from '../hooks/jev'

type Reply = { ok?: boolean; status?: number; body: unknown } | 'hang' | 'throw'

/** A noun over fakes: a fetch that records and answers `reply`, and a timer the test fires. */
function nounOver(reply: Reply, config: { apiKey?: string; model?: string } = { apiKey: 'ts-key' }) {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const timers: (() => void)[] = []
  const deps: JevDeps = {
    config: async () => config,
    fetch: (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      if (reply === 'hang') return new Promise(() => {})
      if (reply === 'throw') return Promise.reject(new Error('socket said Bearer ts-key'))
      return Promise.resolve({
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        text: typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
      })
    },
    after: (_ms, fn) => {
      timers.push(fn)
      return { cancel: () => {} }
    },
    now: () => 0,
  }
  // ask awaits its config before arming the timer, so wait for it to be armed.
  const fire = async () => {
    while (timers.length === 0) await Promise.resolve()
    timers.forEach((fn) => fn())
  }
  return { jev: jevOf(deps), seen, fire }
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return '<resolved>'
}

const ASK = {
  state: { prompt: 'make the button bounce' },
  questions: {
    wants_ui: { type: 'noul', instructions: 'The request changes a user interface.' },
    skill: {
      type: 'choice',
      instructions: 'Which skill fits the request best?',
      criteria: { animate: 'Builds motion.', none: 'No skill fits.' },
    },
    effort: { type: 'score', instructions: 'How big is the change?', criteria: ['Tiny', 'Medium', 'Large'] },
  },
} as const

const OK = {
  model: 'jev-1.13-20260917',
  answers: {
    wants_ui: { type: 'noul', noul: 0.97 },
    skill: { type: 'choice', choice: 'animate', confidence: 0.8, probabilities: { animate: 0.9, none: 0.1 } },
    effort: {
      type: 'score',
      score: 0.4,
      confidence: 0.7,
      probabilities: { '0': 0.6, '1': 0.4, '2': 0 },
      legend: { '0': 'Tiny', '1': 'Medium', '2': 'Large' },
    },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
}

test('sends the wire the MCP uses and returns typed answers', async () => {
  const { jev, seen } = nounOver({ body: OK })
  const result = await jev.ask(ASK)
  expect(seen[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(seen[0]?.headers.authorization).toBe('Bearer ts-key')
  expect(seen[0]?.body.model).toBe('jev-latest')
  expect(result.answers.wants_ui.noul).toBe(0.97)
  expect(result.answers.skill.choice).toBe('animate')
  expect(result.answers.effort.score).toBe(0.4)
  expect(result.model).toBe('jev-1.13-20260917')
})

test('the configured model is sent, and a per-call model wins', async () => {
  const configured = nounOver({ body: OK }, { apiKey: 'k', model: 'jev-1.13' })
  await configured.jev.ask(ASK)
  expect(configured.seen[0]?.body.model).toBe('jev-1.13')
  await configured.jev.ask({ ...ASK, model: 'jev-x' })
  expect(configured.seen[1]?.body.model).toBe('jev-x')
})

test('a hung request rejects when the timer fires', async () => {
  const { jev, fire } = nounOver('hang')
  const pending = messageOf(jev.ask({ ...ASK, timeoutMs: 1500 }))
  await fire()
  expect(await pending).toContain('did not answer within 1500 ms')
})

test('a network error never leaks its text', async () => {
  const message = await messageOf(nounOver('throw').jev.ask(ASK))
  expect(message).toContain('could not reach TypeSafe')
  expect(message).not.toContain('ts-key')
})

test('a non-200 reports the status and a hint, never the body', async () => {
  const message = await messageOf(nounOver({ ok: false, status: 401, body: 'SECRET-ECHO' }).jev.ask(ASK))
  expect(message).toContain('HTTP 401')
  expect(message).toContain('Check TYPESAFE_API_KEY')
  expect(message).not.toContain('SECRET-ECHO')
})

test('an invalid envelope rejects', async () => {
  expect(await messageOf(nounOver({ body: 'not json' }).jev.ask(ASK))).toContain('invalid response envelope')
  expect(await messageOf(nounOver({ body: { answers: {} } }).jev.ask(ASK))).toContain('invalid response envelope')
})

test('a missing or misshapen answer is named', async () => {
  const missing = { ...OK, answers: { wants_ui: OK.answers.wants_ui, skill: OK.answers.skill } }
  expect(await messageOf(nounOver({ body: missing }).jev.ask(ASK))).toContain('"effort"')
  const offList = { ...OK, answers: { ...OK.answers, skill: { ...OK.answers.skill, choice: 'tdd' } } }
  expect(await messageOf(nounOver({ body: offList }).jev.ask(ASK))).toContain('"skill"')
  const outOfRange = { ...OK, answers: { ...OK.answers, effort: { ...OK.answers.effort, score: 3 } } }
  expect(await messageOf(nounOver({ body: outOfRange }).jev.ask(ASK))).toContain('"effort"')
})

test('a missing or broken key fails before any request', async () => {
  const none = nounOver({ body: OK }, {})
  expect(await messageOf(none.jev.ask(ASK))).toContain('no TypeSafe key')
  expect(none.seen.length).toBe(0)
  const smart = nounOver({ body: OK }, { apiKey: 'ts’key' })
  expect(await messageOf(smart.jev.ask(ASK))).toContain('plain ASCII')
  expect(smart.seen.length).toBe(0)
})

test('bad questions fail before any request', async () => {
  const n = nounOver({ body: OK })
  expect(await messageOf(n.jev.ask({ state: 'x', questions: {} }))).toContain('at least one question')
  const oneOption = { q: { type: 'choice', instructions: 'x', criteria: { a: 'only' } } } as const
  expect(await messageOf(n.jev.ask({ state: 'x', questions: oneOption }))).toContain('2 to 255')
  expect(n.seen.length).toBe(0)
})
