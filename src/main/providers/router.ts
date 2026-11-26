/**
 * Provider selection router.
 *
 * Converts provider failures into normalized `ProviderError`s and decides what
 * to do with each candidate: accept it as final, keep it as a fallback, keep
 * searching, or reject it outright.
 */

import type {
  CandidateEvaluation,
  LyricsProviderId,
  LyricsTimingKind,
  ProviderErrorKind,
  ProviderSourceId,
  SelectionDecision
} from '@shared/types'

export interface ProviderErrorOptions {
  providerId: ProviderSourceId
  retryAfterMs?: number
  cause?: unknown
}

/** Typed provider failure carrying a normalized `ProviderErrorKind`. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly providerId: ProviderSourceId
  readonly retryAfterMs?: number

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ProviderError'
    this.kind = kind
    this.providerId = options.providerId
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs
    }
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError
}

const RATE_LIMIT_RE = /\b(?:429|503)\b|rate.?limit|too many requests|temporarily unavailable/i
const NOT_FOUND_RE = /\b404\b|not found|no match/i
const NETWORK_RE =
  /network|fetch failed|failed to fetch|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket|offline|dns/i
const BAD_RESPONSE_RE = /invalid|malformed|unexpected|json|payload|parse|schema|response/i
const ABORT_RE = /abort|cancel/i

/**
 * Maps an arbitrary thrown value to a `ProviderError`. Existing
 * `ProviderError`s pass through unchanged; abort/status/network/payload
 * signatures are matched in that order of specificity.
 */
export function classifyProviderError(
  error: unknown,
  providerId: ProviderSourceId = 'lrclib'
): ProviderError {
  if (error instanceof ProviderError) return error

  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''

  if (name === 'AbortError' || ABORT_RE.test(message)) {
    return new ProviderError('ABORTED', message, { providerId, cause: error })
  }
  if (RATE_LIMIT_RE.test(message)) {
    return new ProviderError('RATE_LIMITED', message, { providerId, cause: error })
  }
  if (NOT_FOUND_RE.test(message)) {
    return new ProviderError('NOT_FOUND', message, { providerId, cause: error })
  }
  if (NETWORK_RE.test(message)) {
    return new ProviderError('NETWORK', message, { providerId, cause: error })
  }
  if (BAD_RESPONSE_RE.test(message)) {
    return new ProviderError('BAD_RESPONSE', message, { providerId, cause: error })
  }
  return new ProviderError('UNKNOWN', message, { providerId, cause: error })
}

export interface EvaluateCandidateInput {
  timingKind: LyricsTimingKind
  score: number
  providerId: LyricsProviderId
  durationDeltaSec?: number
  /** When true, line-synced remote results are only kept as fallbacks. */
  preferWordSynced?: boolean
  /** Local `.lrc` sidecars are authoritative for their own file. */
  isLocalSidecar?: boolean
  /** Minimum confidence for a non-local candidate to be usable. */
  minScore?: number
}

/** Default confidence floor below which a candidate is skipped entirely. */
export const MIN_USABLE_SCORE = 8

/** Absolute floor: below this a non-local candidate is the wrong song. */
export const MIN_CONFIDENCE_SCORE = 35

/** Minimum score for a non-local line-synced candidate to be accepted final. */
export const MIN_ACCEPT_SCORE = 70

/** Duration delta (seconds) permitted for an `ACCEPT_FINAL` remote match. */
export const STRICT_DURATION_DELTA_SEC = 5

/** Duration delta (seconds) beyond which a non-local candidate is rejected. */
export const MAX_DURATION_DELTA_SEC = 30

/**
 * Routes one candidate to a `SelectionDecision`.
 *
 * Enforced confidence gates (non-local providers):
 * - `none` / `instrumental` → `REJECT` (nothing embeddable).
 * - `score < MIN_CONFIDENCE_SCORE` → `REJECT` (wrong song / noise).
 * - `durationDeltaSec > MAX_DURATION_DELTA_SEC` → `REJECT` (different cut).
 * - `score < MIN_USABLE_SCORE` → `CONTINUE` (discard, keep searching).
 * - `word` → `ACCEPT_FINAL`.
 * - `line` → `ACCEPT_FINAL` only when `score >= MIN_ACCEPT_SCORE` and the
 *   duration delta is unknown or `<= STRICT_DURATION_DELTA_SEC`; otherwise
 *   `KEEP_AS_FALLBACK`. `preferWordSynced` downgrades remote `line` to
 *   `KEEP_AS_FALLBACK` regardless of score.
 * - `plain` → `KEEP_AS_FALLBACK` (used only when nothing better exists).
 * - Local `.lrc` sidecars stay authoritative (`ACCEPT_FINAL` when synced).
 */
export function evaluateCandidate(input: EvaluateCandidateInput): CandidateEvaluation {
  const {
    timingKind,
    score,
    preferWordSynced = false,
    isLocalSidecar = false
  } = input
  const durationDeltaSec = input.durationDeltaSec
  const base = {
    timingKind,
    score,
    ...(durationDeltaSec !== undefined ? { durationDeltaSec } : {})
  }

  if (timingKind === 'none') {
    return { ...base, decision: 'REJECT', reason: 'no usable lyrics in candidate' }
  }
  if (timingKind === 'instrumental') {
    return { ...base, decision: 'REJECT', reason: 'instrumental track has no lyrics to embed' }
  }

  const minScore = isLocalSidecar ? 0 : (input.minScore ?? MIN_USABLE_SCORE)
  if (score < minScore) {
    return { ...base, decision: 'CONTINUE', reason: `low confidence score ${score} < ${minScore}` }
  }

  if (timingKind === 'word') {
    if (!isLocalSidecar && score < MIN_CONFIDENCE_SCORE) {
      return {
        ...base,
        decision: 'REJECT',
        reason: `wrong-song confidence score ${score} < ${MIN_CONFIDENCE_SCORE}`
      }
    }
    return { ...base, decision: 'ACCEPT_FINAL', reason: 'word-synced lyrics' }
  }

  if (timingKind === 'line') {
    if (isLocalSidecar) {
      return { ...base, decision: 'ACCEPT_FINAL', reason: 'line-synced local .lrc sidecar' }
    }
    if (score < MIN_CONFIDENCE_SCORE) {
      return {
        ...base,
        decision: 'REJECT',
        reason: `wrong-song confidence score ${score} < ${MIN_CONFIDENCE_SCORE}`
      }
    }
    if (durationDeltaSec !== undefined && durationDeltaSec > MAX_DURATION_DELTA_SEC) {
      return {
        ...base,
        decision: 'REJECT',
        reason: `duration mismatch ${durationDeltaSec}s > ${MAX_DURATION_DELTA_SEC}s`
      }
    }
    if (preferWordSynced) {
      return {
        ...base,
        decision: 'KEEP_AS_FALLBACK',
        reason: 'line-synced; prefer word-synced result'
      }
    }
    const durationOk =
      durationDeltaSec === undefined || durationDeltaSec <= STRICT_DURATION_DELTA_SEC
    if (score >= MIN_ACCEPT_SCORE && durationOk) {
      return { ...base, decision: 'ACCEPT_FINAL', reason: 'line-synced lyrics' }
    }
    return {
      ...base,
      decision: 'KEEP_AS_FALLBACK',
      reason: durationOk
        ? `line-synced mid-confidence score ${score} < ${MIN_ACCEPT_SCORE}`
        : `line-synced duration delta ${durationDeltaSec}s > ${STRICT_DURATION_DELTA_SEC}s`
    }
  }

  return { ...base, decision: 'KEEP_AS_FALLBACK', reason: 'plain lyrics only' }
}

const DECISION_RANK: Record<SelectionDecision, number> = {
  ACCEPT_FINAL: 3,
  KEEP_AS_FALLBACK: 2,
  CONTINUE: 1,
  REJECT: 0
}

const TIMING_RANK: Record<LyricsTimingKind, number> = {
  word: 4,
  line: 3,
  plain: 2,
  instrumental: 1,
  none: 0
}

/**
 * Compares two evaluations: positive when `a` is the better candidate.
 * Ordering is decision rank, score, timing granularity, then smallest
 * duration delta.
 */
export function compareEvaluations(a: CandidateEvaluation, b: CandidateEvaluation): number {
  const decision = DECISION_RANK[a.decision] - DECISION_RANK[b.decision]
  if (decision !== 0) return decision

  if (a.score !== b.score) return a.score - b.score

  const timing = TIMING_RANK[a.timingKind] - TIMING_RANK[b.timingKind]
  if (timing !== 0) return timing

  const deltaA = a.durationDeltaSec ?? Number.POSITIVE_INFINITY
  const deltaB = b.durationDeltaSec ?? Number.POSITIVE_INFINITY
  if (deltaA !== deltaB) return deltaB - deltaA
  return 0
}

/** Keeps the better of two evaluated candidates (returns `incoming` on ties). */
export function pickBetterCandidate<T extends { evaluation: CandidateEvaluation }>(
  current: T | null,
  incoming: T
): T {
  if (current === null) return incoming
  return compareEvaluations(incoming.evaluation, current.evaluation) > 0 ? incoming : current
}
