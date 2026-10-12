// iCaptcha — the orchestrator. Issues challenges, grades answers, escalates
// difficulty on failure, and mints a proof on success. Stateless: all session
// state lives in the sealed token the client carries.

import type { ICaptchaConfig } from './config.ts'
import { buildRegistry, type Registry } from './generators/index.ts'
import { clampLevel, escalate } from './difficulty.ts'
import { gradeDefault } from './grader.ts'
import { TokenSealer } from './token.ts'
import { Prover } from './proof.ts'
import { choice, randId } from './rng.ts'
import type {
  AnswerResult,
  Challenge,
  ChallengeType,
  Generator,
  SealedState,
} from './types.ts'

export class InvalidTokenError extends Error {}
export class ExpiredChallengeError extends Error {}

export interface IssueOptions {
  requesterId?: string
  requiredLevel?: number
  maxAttempts?: number
  types?: ChallengeType[]
}

export interface EngineDeps {
  registry?: Registry
  now?: () => number
}

export class Engine {
  readonly cfg: ICaptchaConfig
  private readonly registry: Registry
  private readonly sealer: TokenSealer
  readonly prover: Prover
  private readonly now: () => number
  // Consumed challenge tokens (jti -> expiry, unix sec). A token may be
  // answered once; entries are pruned as they expire so this stays bounded.
  private readonly seen = new Map<string, number>()

  constructor(cfg: ICaptchaConfig, deps: EngineDeps = {}) {
    this.cfg = cfg
    this.registry = deps.registry ?? buildRegistry(cfg)
    this.sealer = new TokenSealer(cfg.secret)
    this.prover = new Prover(cfg.signingKey)
    this.now = deps.now ?? Date.now
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  /** Drop consumed-token records whose challenge TTL has elapsed. */
  private pruneSeen(): void {
    const now = this.nowSec()
    for (const [jti, exp] of this.seen) {
      if (exp <= now) this.seen.delete(jti)
    }
  }

  /** Pick a generator for `difficulty` (optionally constrained to `types`) and
   *  generate a problem. Falls back to a deterministic generator if an LLM
   *  generator errors, so issuance never hard-fails. */
  private async generate(
    difficulty: number,
    types?: ChallengeType[],
  ): Promise<{ type: ChallengeType; prompt: string; answer: string }> {
    let pool: Generator[] = this.registry.eligible(difficulty)
    if (types && types.length) pool = pool.filter((g) => types.includes(g.type))
    if (!pool.length) pool = this.registry.eligibleDeterministic(difficulty)
    if (!pool.length) throw new Error('no eligible challenge generators')

    const gen = choice(pool)
    try {
      const g = await gen.generate(difficulty)
      return { type: gen.type, prompt: g.prompt, answer: g.answer }
    } catch {
      // LLM generation failed — fall back to a deterministic generator.
      const det = this.registry.eligibleDeterministic(difficulty)
      if (!det.length) throw new Error('no deterministic fallback available')
      const fb = choice(det)
      const g = await fb.generate(difficulty)
      return { type: fb.type, prompt: g.prompt, answer: g.answer }
    }
  }

  private async buildChallenge(state: SealedState): Promise<Challenge> {
    const token = await this.sealer.seal(state)
    return {
      challengeId: state.cid,
      type: state.type,
      difficulty: state.difficulty,
      prompt: '', // filled by caller; prompt isn't stored in the seal
      expiresAt: new Date(state.exp * 1000).toISOString(),
      attemptsRemaining: state.maxAttempts - state.attempts,
      token,
    }
  }

  async issueChallenge(opts: IssueOptions = {}): Promise<Challenge> {
    const level = clampLevel(opts.requiredLevel ?? this.cfg.requiredLevel, this.cfg)
    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.cfg.maxAttempts)
    const { type, prompt, answer } = await this.generate(level, opts.types)

    const iat = this.nowSec()
    const state: SealedState = {
      cid: randId(),
      type,
      difficulty: level,
      answer,
      requesterId: opts.requesterId,
      attempts: 0,
      maxAttempts,
      requiredLevel: level,
      iat,
      exp: iat + this.cfg.challengeTtlSeconds,
      jti: randId(),
    }
    const challenge = await this.buildChallenge(state)
    return { ...challenge, prompt }
  }

  async submitAnswer(token: string, answer: string): Promise<AnswerResult> {
    let state: SealedState
    try {
      state = await this.sealer.unseal(token)
    } catch {
      throw new InvalidTokenError('invalid or tampered token')
    }
    if (this.nowSec() > state.exp) throw new ExpiredChallengeError('challenge expired')

    // Single-use: bind the attempt budget and difficulty escalation to one
    // logical session. Without this the client can replay the original
    // (attempts: 0) token unchanged, so the budget never trips and the
    // difficulty never rises — a scripted solver just brute-forces the small
    // answer space at the issued level and collects a genuine proof.
    this.pruneSeen()
    if (this.seen.has(state.jti)) throw new InvalidTokenError('challenge token already used')
    this.seen.set(state.jti, state.exp)

    const gen = this.registry.byType.get(state.type)
    const correct = gen?.grade
      ? await gen.grade(answer ?? '', state.answer)
      : gradeDefault(answer ?? '', state.answer)

    if (correct) {
      const iat = this.nowSec()
      const proof = this.prover.issue({
        sub: state.requesterId ?? 'anonymous',
        level: state.difficulty,
        iss: 'icaptcha',
        iat,
        exp: iat + this.cfg.proofTtlSeconds,
        jti: randId(),
      })
      return { status: 'passed', level: state.difficulty, proof }
    }

    const attempts = state.attempts + 1
    if (attempts >= state.maxAttempts) {
      return { status: 'failed', reason: 'attempt budget exhausted' }
    }

    // Wrong answer: escalate difficulty and re-issue.
    const nextLevel = escalate(state.difficulty, this.cfg)
    const { type, prompt, answer: nextAnswer } = await this.generate(nextLevel)
    const iat = this.nowSec()
    const nextState: SealedState = {
      cid: randId(),
      type,
      difficulty: nextLevel,
      answer: nextAnswer,
      requesterId: state.requesterId,
      attempts,
      maxAttempts: state.maxAttempts,
      requiredLevel: state.requiredLevel,
      iat,
      exp: iat + this.cfg.challengeTtlSeconds,
      jti: randId(),
    }
    const challenge = await this.buildChallenge(nextState)
    return {
      status: 'continue',
      challenge: { ...challenge, prompt },
      attemptsRemaining: nextState.maxAttempts - nextState.attempts,
    }
  }
}
