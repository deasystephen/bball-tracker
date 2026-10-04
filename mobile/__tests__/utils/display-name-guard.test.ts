/**
 * Guard: user names render through `utils/display-name.ts#displayName` (#674).
 *
 * A deleted account is a tombstone whose stored `name` is an English literal.
 * `displayName` renders the localized `account.deletedUser` from `deletedAt`;
 * a raw `.name` read shows the English literal in every locale. This reads the
 * screens and components and fails on a `.name` read off a user-shaped object:
 * any `…player` / `…Player` (`player`, `selectedPlayer`, `item.player`), any
 * `<x>.user` (`row.user`, `s.user` on staff rows), `invitedBy` and `author`.
 *
 * The one exemption is a bare `user` that the same file binds from the auth
 * store (`const user = useAuthUser()`, `const { user } = useAuthStore()`): the
 * signed-in user is never a tombstone. A bare `user` bound any other way is
 * reported. `team.name`, `season.name` and `league.name` are not user-shaped.
 * Sorting by the stored name in `utils/roster-sort.ts` is fine; `utils/` is
 * not scanned.
 *
 * To fix a finding, render `displayName(item.player)` instead.
 */

import fs from 'fs';
import path from 'path';

import { MOBILE_ROOT, scanLines, sourceFiles } from '../helpers/source-files';

const SCANNED_DIRS = ['app', 'components'];
const RAW_USER_NAME = /\b(?:\w*[pP]layer|\w+\.user|invitedBy|author)\??\.name\b/;
/** A bare `user.name` (no owner object in front of `user`). */
const BARE_USER_NAME = /(?<![\w.])user\??\.name\b/;
const AUTH_STORE_USER = /const\s+(?:user|\{[^}]*\buser\b[^}]*\})\s*=\s*useAuth(?:User|Store)\(/;

export function findRawUserNames(fileName: string, text: string): string[] {
  const findings = scanLines(fileName, text, RAW_USER_NAME);
  if (!AUTH_STORE_USER.test(text)) findings.push(...scanLines(fileName, text, BARE_USER_NAME));
  return findings;
}

describe('user names render through displayName', () => {
  it('finds no raw .name read on a user-shaped object in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir), ['.ts', '.tsx']));
    // A guard that scans nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);

    const findings = files.flatMap((file) =>
      findRawUserNames(path.relative(MOBILE_ROOT, file), fs.readFileSync(file, 'utf8'))
    );

    expect(findings).toEqual([]);
  });

  describe('the scanner', () => {
    it.each([
      'title={menuMember.player.name}',
      'Invited by {item.invitedBy.name}',
      "{item.player?.name || 'Unknown Player'}",
      '{announcement.author.name}',
      "const playerName = member?.player.name ?? 'Player';",
      '<ThemedText>{selectedPlayer.name}</ThemedText>',
      '{row.user.name}',
      "staff.map((s) => s.user?.name).join(', ')",
    ])('reports %s', (line) => {
      expect(findRawUserNames('sample.tsx', line)).toHaveLength(1);
    });

    it.each([
      'title={displayName(menuMember.player)}',
      '{team.name}',
      '{season.name}',
      'const playerName = displayName(member?.player);',
      '{displayName(row.user)}',
    ])('accepts %s', (line) => {
      expect(findRawUserNames('sample.tsx', line)).toEqual([]);
    });

    it('accepts a bare user.name only where the file binds user from the auth store', () => {
      const render = '<Text>{user?.name}</Text>';

      expect(findRawUserNames('a.tsx', `const user = useAuthUser();\n${render}`)).toEqual([]);
      expect(findRawUserNames('b.tsx', `const { user, logout } = useAuthStore();\n${render}`)).toEqual([]);
      expect(findRawUserNames('c.tsx', `const user = staff.find((s) => s.id === id);\n${render}`)).toEqual([
        'c.tsx:2 <Text>{user?.name}</Text>',
      ]);
    });
  });
});
