import { describe, expect, it, vi } from 'vitest'

const { withDatabase } = await vi.importActual<typeof import('../../src/db')>('../../src/db')

describe('database connection failures', () => {
  it('reports an unavailable database without exposing the driver failure', async () => {
    await expect(
      withDatabase(
        'postgresql://postgres:postgres@127.0.0.1:1/seb_backend',
        async () => undefined,
      ),
    ).rejects.toThrow('The database is temporarily unavailable.')
  })
})
