/**
 * Guard: user names render through `utils/display-name.ts#displayName` (#674).
 *
 * A deleted account is a tombstone whose stored `name` is an English literal.
 * `displayName` renders the localized `account.deletedUser` from `deletedAt`;
 * a raw `.name` read shows the English literal in every locale. This reads the
 * screens and components and fails on a `.name` read off a user-shaped object
 * (`player`, `invitedBy`, `author`).
 *
 * Out of reach: names read off other identifiers (`user?.name` for the
 * signed-in user, who is never a tombstone; `team.name`, `season.name`).
 * Sorting by the stored name in `utils/roster-sort.ts` is fine; `utils/` is
 * not scanned.
 *
 * To fix a finding, render `displayName(item.player)` instead.
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_DIRS = ['app', 'components'];
const RAW_USER_NAME = /\b(?:player|invitedBy|author)\??\.name\b/;

export function findRawUserNames(fileName: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) => (RAW_USER_NAME.test(line) ? [`${fileName}:${index + 1} ${line.trim()}`] : []));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('user names render through displayName', () => {
  it('finds no raw .name read on a user-shaped object in the app', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(MOBILE_ROOT, dir)));
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
    ])('reports %s', (line) => {
      expect(findRawUserNames('sample.tsx', line)).toHaveLength(1);
    });

    it.each([
      'title={displayName(menuMember.player)}',
      '{team.name}',
      '{user?.name}',
      'const playerName = displayName(member?.player);',
      '{season.name}',
    ])('accepts %s', (line) => {
      expect(findRawUserNames('sample.tsx', line)).toEqual([]);
    });
  });
});
