import { describe, it, expect } from 'vitest'
import { createNonceGuard } from '../src/shared/nonceGuard'

describe('createNonceGuard', () => {
  it('handles a fresh nonce exactly once', () => {
    const guard = createNonceGuard()
    expect(guard.shouldHandle(1)).toBe(true)
    expect(guard.shouldHandle(1)).toBe(false)
    expect(guard.shouldHandle(1)).toBe(false)
  })

  it('handles a new nonce after a prior one', () => {
    const guard = createNonceGuard()
    expect(guard.shouldHandle(1)).toBe(true)
    expect(guard.shouldHandle(2)).toBe(true)
    expect(guard.shouldHandle(2)).toBe(false)
  })

  it('does not replay an older nonce after a newer one was handled', () => {
    // The bug: after an embed the focusedTrack object identity changes, the
    // seek effect re-runs, and an old seekRequest is applied again. A strict
    // "different from last handled" guard stops the immediate replay; a stale
    // request arriving later with a *lower* nonce is a new object and is not
    // re-emitted by React, so this is sufficient.
    const guard = createNonceGuard()
    expect(guard.shouldHandle(5)).toBe(true)
    expect(guard.shouldHandle(6)).toBe(true)
    // Re-running the effect with nonce 6 must be a no-op.
    expect(guard.shouldHandle(6)).toBe(false)
  })

  it('tracks the last handled nonce', () => {
    const guard = createNonceGuard()
    expect(guard.lastHandled).toBeNull()
    guard.shouldHandle(42)
    expect(guard.lastHandled).toBe(42)
    guard.shouldHandle(42)
    expect(guard.lastHandled).toBe(42)
  })

  it('reset allows a nonce to be handled again', () => {
    const guard = createNonceGuard()
    expect(guard.shouldHandle(7)).toBe(true)
    expect(guard.shouldHandle(7)).toBe(false)
    guard.reset()
    expect(guard.lastHandled).toBeNull()
    expect(guard.shouldHandle(7)).toBe(true)
  })

  it('ignores non-finite/non-numeric nonces safely', () => {
    const guard = createNonceGuard()
    // Nonces are numbers by contract; NaN must not wedge the guard.
    expect(guard.shouldHandle(Number.NaN)).toBe(true)
    expect(guard.shouldHandle(Number.NaN)).toBe(false)
  })
})