import { describe, it, expect } from 'vitest'
import {
  ProviderError,
  classifyProviderError,
  evaluateCandidate,
  compareEvaluations,
  pickBetterCandidate
} from '../src/main/providers/router'
import type { CandidateEvaluation } from '../src/shared/types'

describe('ProviderError / classifyProviderError', () => {
  it('preserves an existing ProviderError unchanged', () => {
    const original = new ProviderError('RATE_LIMITED', 'too many requests', {
      providerId: 'lrclib',
      retryAfterMs: 5000
    })
    const classified = classifyProviderError(original, 'localSidecar')
    expect(classified).toBe(original)
    expect(classified.kind).toBe('RATE_LIMITED')
    expect(classified.retryAfterMs).toBe(5000)
  })

  it('classifies rate-limit and not-found messages', () => {
    expect(classifyProviderError(new Error('LRCLIB rate-limited (HTTP 429)')).kind).toBe(
      'RATE_LIMITED'
    )
    expect(classifyProviderError(new Error('HTTP 503 unavailable')).kind).toBe('RATE_LIMITED')
    expect(classifyProviderError(new Error('HTTP 404')).kind).toBe('NOT_FOUND')
  })

  it('classifies network, bad-response, aborted, and unknown errors', () => {
    expect(classifyProviderError(new Error('Network down')).kind).toBe('NETWORK')
    expect(classifyProviderError(new TypeError('fetch failed')).kind).toBe('NETWORK')
    expect(classifyProviderError(new Error('invalid JSON payload')).kind).toBe('BAD_RESPONSE')
    expect(classifyProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' })).kind).toBe(
      'ABORTED'
    )
    expect(classifyProviderError(new Error('something odd')).kind).toBe('UNKNOWN')
  })
})

describe('evaluateCandidate', () => {
  const base = { score: 50, providerId: 'lrclib' as const }

  it('rejects candidates with no timing data', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'none' })
    expect(result.decision).toBe('REJECT')
    expect(result.reason).toMatch(/no usable lyrics/)
  })

  it('rejects instrumental tracks (nothing to embed)', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'instrumental' })
    expect(result.decision).toBe('REJECT')
  })

  it('accepts a high-confidence word-synced candidate as final', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'word', score: 80 })
    expect(result.decision).toBe('ACCEPT_FINAL')
  })

  it('rejects wrong-song / low-score line candidates instead of accepting them', () => {
    // A `line` candidate for the wrong song used to be ACCEPT_FINAL; the
    // confidence gate must reject it so the queue keeps searching.
    const wrongSong = evaluateCandidate({ ...base, timingKind: 'line', score: 20 })
    expect(wrongSong.decision).toBe('REJECT')
    expect(wrongSong.reason).toMatch(/wrong-song/)

    const lowScoreWord = evaluateCandidate({ ...base, timingKind: 'word', score: 10 })
    expect(lowScoreWord.decision).toBe('REJECT')
  })

  it('rejects non-local candidates whose duration differs by more than 30s', () => {
    const result = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 90,
      durationDeltaSec: 31
    })
    expect(result.decision).toBe('REJECT')
    expect(result.reason).toMatch(/duration mismatch/)
  })

  it('accepts a high-score line candidate within 5s as final', () => {
    const result = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 75,
      durationDeltaSec: 4
    })
    expect(result.decision).toBe('ACCEPT_FINAL')
  })

  it('treats an unknown duration delta as acceptable for a high-score match', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'line', score: 72 })
    expect(result.decision).toBe('ACCEPT_FINAL')
  })

  it('keeps mid-confidence (>= 35) line candidates as fallback', () => {
    const midScore = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 55,
      durationDeltaSec: 2
    })
    expect(midScore.decision).toBe('KEEP_AS_FALLBACK')

    const farDuration = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 95,
      durationDeltaSec: 12
    })
    expect(farDuration.decision).toBe('KEEP_AS_FALLBACK')
    expect(farDuration.reason).toMatch(/duration delta/)
  })

  it('keeps line-synced as fallback when preferWordSynced is true and not local', () => {
    const result = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 90,
      preferWordSynced: true
    })
    expect(result.decision).toBe('KEEP_AS_FALLBACK')
    expect(result.reason).toMatch(/prefer word/)
  })

  it('accepts line-synced as final when it is a local sidecar', () => {
    const result = evaluateCandidate({
      ...base,
      timingKind: 'line',
      score: 40,
      durationDeltaSec: 90,
      preferWordSynced: true,
      isLocalSidecar: true
    })
    expect(result.decision).toBe('ACCEPT_FINAL')
  })

  it('accepts line-synced as final when preferWordSynced is false', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'line', score: 90 })
    expect(result.decision).toBe('ACCEPT_FINAL')
  })

  it('keeps plain lyrics as fallback', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'plain', preferWordSynced: true })
    expect(result.decision).toBe('KEEP_AS_FALLBACK')
  })

  it('continues past low-confidence non-local candidates', () => {
    const result = evaluateCandidate({ ...base, timingKind: 'word', score: 3 })
    expect(result.decision).toBe('CONTINUE')
  })

  it('retains low-confidence local sidecars', () => {
    const result = evaluateCandidate({
      ...base,
      timingKind: 'plain',
      score: 3,
      isLocalSidecar: true
    })
    expect(result.decision).toBe('KEEP_AS_FALLBACK')
  })
})

function evaluation(overrides: Partial<CandidateEvaluation> = {}): CandidateEvaluation {
  return {
    timingKind: 'line',
    score: 50,
    decision: 'KEEP_AS_FALLBACK',
    reason: 'test',
    ...overrides
  }
}

describe('compareEvaluations / pickBetterCandidate', () => {
  it('ranks ACCEPT_FINAL above KEEP_AS_FALLBACK', () => {
    const final = evaluation({ decision: 'ACCEPT_FINAL' })
    const fallback = evaluation({ decision: 'KEEP_AS_FALLBACK' })
    expect(compareEvaluations(final, fallback)).toBeGreaterThan(0)

    const wrappedFinal = { evaluation: final }
    const wrappedFallback = { evaluation: fallback }
    expect(pickBetterCandidate(wrappedFallback, wrappedFinal)).toBe(wrappedFinal)
    expect(pickBetterCandidate(wrappedFinal, wrappedFallback)).toBe(wrappedFinal)
  })

  it('prefers higher score at the same decision', () => {
    const higher = evaluation({ score: 90 })
    const lower = evaluation({ score: 40 })
    expect(compareEvaluations(higher, lower)).toBeGreaterThan(0)
  })

  it('prefers word timing and then smaller duration delta on ties', () => {
    const word = evaluation({ timingKind: 'word' })
    const line = evaluation({ timingKind: 'line' })
    expect(compareEvaluations(word, line)).toBeGreaterThan(0)

    const close = evaluation({ durationDeltaSec: 1 })
    const far = evaluation({ durationDeltaSec: 10 })
    expect(compareEvaluations(close, far)).toBeGreaterThan(0)
  })

  it('returns incoming when there is no current candidate', () => {
    const incoming = { evaluation: evaluation() }
    expect(pickBetterCandidate(null, incoming)).toBe(incoming)
  })
})
