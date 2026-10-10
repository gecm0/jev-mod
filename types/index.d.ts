/**
 * The `$.jev` noun: typed judgments from TypeSafe's Jev, one state at a time.
 *
 * Self-contained on purpose: a mod that lists `jev` under `dependencies` gets
 * this file laid into its own types folder.
 */

/**
 * Asks Jev questions over one state.
 *
 * A caller in a gating hook (`prompt.submit`, `tool.call`) should fail open:
 * wrap the call in try/catch, or add a `.catch` on its registration, so a
 * timeout or an outage never blocks the person.
 */
export type Jev = {
  /**
   * Answers every question in one request; they run in parallel and cannot
   * see each other. Rejects on a missing key, a timeout, a non-200, or an
   * answer that does not fit its question. Error messages never carry the
   * response body, which can echo the state.
   *
   * @example
   * const { answers } = await $.jev.ask({
   *   state: { command: e.command },
   *   questions: {
   *     destructive: {
   *       type: 'noul',
   *       instructions: 'The command deletes files that cannot be reproduced.',
   *       criteria: { true: 'Removes source or data.', false: 'Removes build output.' },
   *     },
   *   },
   *   timeoutMs: 1500,
   * })
   * if (answers.destructive.noul > 0.9) return { deny: 'looks destructive' }
   */
  ask: <Q extends JevQuestions>(request: JevRequest<Q>) => Promise<JevResult<Q>>
}

export type JevQuestions = Readonly<Record<string, JevQuestion>>

export type JevRequest<Q extends JevQuestions = JevQuestions> = {
  /** Everything Jev sees: it never reads the conversation or files. Send only what the question needs. */
  state: JevText
  /** Questions by id. Ids are not sent to Jev, so instructions and criteria must carry the meaning. */
  questions: Q
  /** Overrides the configured model for this call. */
  model?: string
  /**
   * Gives up after this long (default 4000, capped at 9000 to stay inside a
   * hook's 10 s budget). The request itself cannot be cancelled, only abandoned.
   */
  timeoutMs?: number
}

/** A sentence, or structured text where definitions or examples help. */
export type JevText = string | Readonly<Record<string, unknown>> | readonly unknown[]

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

/** Whether a condition holds. */
export type JevNoulQuestion = {
  type: 'noul'
  instructions: JevText
  criteria?: { true?: JevText; false?: JevText }
}

/** One option of a set. Add a no-match option when nothing may fit. */
export type JevChoiceQuestion = {
  type: 'choice'
  instructions: JevText
  /** 2 to 255 option names, each with the guidance that picks it (null when self-evident). */
  criteria: Readonly<Record<string, JevText | null>>
}

/** A position on an ordered rubric. */
export type JevScoreQuestion = {
  type: 'score'
  instructions: JevText
  /** 2 to 10 levels, lowest first. */
  criteria: readonly JevText[]
}

/** The probability of yes, 0 to 1. Near 0.5 means torn, not "medium". */
export type JevNoulAnswer = { type: 'noul'; noul: number }

export type JevChoiceAnswer = {
  type: 'choice'
  choice: string
  /** Every option's probability, keyed by option name. */
  probabilities: Readonly<Record<string, number>>
  /** How concentrated the distribution is, 0 to 1. Not a claim of truth. */
  confidence: number
}

export type JevScoreAnswer = {
  type: 'score'
  /** 0 to levels - 1, fractional: the expected level. */
  score: number
  /** Keyed "0" to "n-1". */
  probabilities: Readonly<Record<string, number>>
  confidence: number
  legend: Readonly<Record<string, JevText>>
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

/** The answer type a question gets back, so `answers.x.noul` needs no narrowing. */
export type JevAnswerOf<T extends JevQuestion> = T extends { type: 'noul' }
  ? JevNoulAnswer
  : T extends { type: 'choice' }
    ? JevChoiceAnswer
    : JevScoreAnswer

export type JevResult<Q extends JevQuestions = JevQuestions> = {
  /** The dated build that answered (`jev-1.13-20260917`). */
  model: string
  answers: { readonly [K in keyof Q]: JevAnswerOf<Q[K]> }
  /** Output tokens bill at zero. */
  usage: { input_tokens: number; output_tokens: number }
  elapsedMs: number
}

declare module 'claude-code' {
  interface EngineInterface {
    /** Present only where the jev mod is enabled. */
    jev: Jev
  }
}
