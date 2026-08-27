/**
 * The one swallow in the codebase, proven once.
 *
 * Every notification hook and failure-audit runs through `bestEffort`, and the
 * rule they all rely on — a rejected side effect never surfaces — was an
 * assumption spread across anonymous `.catch` lambdas before this existed.
 */
import { describe, expect, it, vi } from 'vitest'
import { bestEffort } from '../../src/services/best-effort'

describe('bestEffort', () => {
  it('waits for the work and returns nothing', async () => {
    let done = false
    await bestEffort(Promise.resolve().then(() => { done = true }))
    expect(done).toBe(true)
  })

  it('swallows a rejection, saying so on the console when asked', async () => {
    const spoke = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(bestEffort(Promise.reject(new Error('boom')), 'It failed'))
        .resolves.toBeUndefined()
      expect(spoke).toHaveBeenCalledWith('It failed')
      // And silently when not asked — a failure with no message is still not
      // an error the caller sees.
      await expect(bestEffort(Promise.reject(new Error('boom'))))
        .resolves.toBeUndefined()
      expect(spoke).toHaveBeenCalledTimes(1)
    } finally {
      spoke.mockRestore()
    }
  })
})
