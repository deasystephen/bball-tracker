import { SUPERSEDE_LOCK_TIMEOUT_MS, setLocalLockTimeout } from '../../src/utils/lock-timeout';
import type { Prisma } from '@prisma/client';

describe('setLocalLockTimeout (#908)', () => {
  it('sets a transaction-local lock_timeout with a bound parameter, below Prisma\'s 5 s transaction timeout', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await setLocalLockTimeout({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, SUPERSEDE_LOCK_TIMEOUT_MS);

    expect(SUPERSEDE_LOCK_TIMEOUT_MS).toBeLessThan(5000);
    const [strings, ...values] = queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain("set_config('lock_timeout', ?, true)");
    expect(values).toEqual(['4000ms']);
  });
});
