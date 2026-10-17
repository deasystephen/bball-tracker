import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { STRINGS } from '../lib/strings';

describe('web strings parity with mobile', () => {
  it('deletedUser equals mobile account.deletedUser', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../mobile/i18n/locales/en.json'), 'utf8')) as {
      account: { deletedUser: string };
    };
    expect(STRINGS.deletedUser).toBe(en.account.deletedUser);
  });
});
