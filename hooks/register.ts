import type { Register } from 'claude-code'

import { jevOf } from './jev'

/** A non-empty plugin option, else what the environment holds. */
function pick(option: unknown, fromEnv: string | undefined): string | undefined {
  return typeof option === 'string' && option.trim() !== '' ? option : fromEnv
}

export const register: Register = (on, options) => {
  // `$` is empty in engine.create; everything goes through the nouns beneath.
  on('engine.create', async ($, e, next) => {
    const beneath = await next(e)
    const jev = jevOf({
      // Read on every call, so a key set mid-session takes. The loader only
      // allows env names spelled as literals at the call site.
      config: async () => ({
        apiKey: pick(options.typesafe_api_key, await beneath.env.get('TYPESAFE_API_KEY')),
        model: pick(options.model, await beneath.env.get('TYPESAFE_MODEL')),
      }),
      fetch: async (url, init) => {
        const { ok, status, text } = await beneath.http.fetch(url, init)
        return { ok, status, text }
      },
      after: (ms, fn) => beneath.clock.after(ms, fn),
      now: () => Date.now(),
    })
    return { ...beneath, jev }
  })
}
