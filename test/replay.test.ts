import { expect, test, describe } from 'bun:test'
import { Engine, InvalidTokenError } from '../src/engine.ts'
import { loadConfig, type ICaptchaConfig } from '../src/config.ts'
import { generateSigningKey } from '../src/proof.ts'
import { TokenSealer } from '../src/token.ts'
import type { SealedState } from '../src/types.ts'

function makeCfg(over: Partial<ICaptchaConfig> = {}): ICaptchaConfig {
  return {
    ...loadConfig(),
    secret: 'replay-test-secret',
    signingKey: generateSigningKey(),
    gatewayKey: '',
    enabledTypes: ['arithmetic', 'algebra', 'sequence', 'anagram', 'logic'],
    requiredLevel: 3,
    maxAttempts: 1,
    challengeTtlSeconds: 120,
    proofTtlSeconds: 300,
    ...over,
  }
}

describe('challenge token single-use', () => {
  test('the original token cannot be replayed after an answer', async () => {
    const engine = new Engine(makeCfg())
    const challenge = await engine.issueChallenge({ requiredLevel: 3 })

    // First submission (wrong) consumes the token.
    const first = await engine.submitAnswer(challenge.token, '__wrong__')
    expect(first.status).toBe('failed') // maxAttempts: 1

    // Replaying the same pristine token must be rejected, not re-graded.
    await expect(engine.submitAnswer(challenge.token, '__wrong__')).rejects.toBeInstanceOf(
      InvalidTokenError,
    )
  })

  test('brute-forcing the same token cannot mint a proof', async () => {
    const cfg = makeCfg()
    const engine = new Engine(cfg)
    const sealer = new TokenSealer(cfg.secret)
    const challenge = await engine.issueChallenge({ requiredLevel: 3 })
    const trueAnswer = ((await sealer.unseal(challenge.token)) as SealedState).answer

    // Burn the single use on a wrong guess.
    await engine.submitAnswer(challenge.token, '__wrong__')

    // Now replay the same token with the correct answer: must be refused.
    await expect(engine.submitAnswer(challenge.token, trueAnswer)).rejects.toBeInstanceOf(
      InvalidTokenError,
    )
  })

  test('the legitimate escalation flow still works one token at a time', async () => {
    const cfg = makeCfg({ maxAttempts: 4 })
    const engine = new Engine(cfg)
    const sealer = new TokenSealer(cfg.secret)

    let challenge = await engine.issueChallenge({ requiredLevel: 3 })
    // Answer the first token wrong -> get a fresh escalated token.
    const r = await engine.submitAnswer(challenge.token, '__wrong__')
    expect(r.status).toBe('continue')
    if (r.status !== 'continue') throw new Error('unreachable')
    // The fresh token is usable once and grades a correct answer to a pass.
    const nextAnswer = ((await sealer.unseal(r.challenge.token)) as SealedState).answer
    const pass = await engine.submitAnswer(r.challenge.token, nextAnswer)
    expect(pass.status).toBe('passed')
  })
})
