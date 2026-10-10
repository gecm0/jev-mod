# jev

A Claude Code mod that adds `$.jev` to the engine, so other mods can ask
[TypeSafe's Jev](https://typesafe.ai) typed Choice, Score and Noul questions and
get calibrated probabilities back.

```ts
const { answers } = await $.jev.ask({
  state: { command: e.command },
  questions: {
    destructive: {
      type: 'noul',
      instructions: 'The command deletes files that cannot be reproduced.',
      criteria: { true: 'Removes source or data.', false: 'Removes build output.' },
    },
  },
  timeoutMs: 1500,
})
if (answers.destructive.noul > 0.9) return { deny: 'looks destructive' }
```

- TypeSafe API only (`https://api.typesafe.ai/v1/systemone`).
- Timeout per call: 4 s by default, 9 s at most. The request is abandoned, not cancelled.
- Every answer is checked against its question before it is returned.
- Error messages carry the HTTP status and a hint, never the response body.

The full contract is [`types/index.d.ts`](types/index.d.ts). A mod that lists
`jev` under `dependencies` gets those types laid into its own types folder.

## Install

Needs Claude Code v2.1.287 or later.

```
/plugin install jev --marketplace gecm0/jev-mod
```

Set the key in `/plugin` → Installed → jev → Configure options (kept in the
keychain), or export `TYPESAFE_API_KEY` in the shell that starts `claude`.
`TYPESAFE_MODEL` overrides the model (default `jev-latest`). These are the same
variables [`jev-judge-mcp`](https://github.com/gecm0/jev-judge-mcp) reads.

## Data

Nothing is sent until a mod calls `$.jev.ask`. Each call sends the `state` and
`questions` that mod passes, plus the model id, to `api.typesafe.ai` only.

## Development

```bash
claude --plugin-dir .     # load from disk, hot-reloads on save
claude plugin validate .
claude plugin test .      # offline: fake fetch, no key needed
```
