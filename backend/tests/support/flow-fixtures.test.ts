/**
 * The seed and the Maestro flows must agree on what the flows create (#584).
 *
 * `live-spectator.yaml` creates a game against "Spectator Rival" on every run.
 * The seed's list of flow-created games did not name it, so those games piled
 * up, each one still IN_PROGRESS, until the Games tab was a column of live
 * games. Nothing failed; the list was simply out of date.
 */

import fs from 'fs';
import path from 'path';
import { FLOW_CREATED_OPPONENTS, FLOW_CREATED_PRACTICE_TITLES } from './flow-fixtures';

const MAESTRO_DIR = path.resolve(__dirname, '..', '..', '..', '.maestro');

/** Opponent names typed on the Create Game screen, per flow file. */
function opponentsTypedByFlows(): { flow: string; opponent: string }[] {
  const found: { flow: string; opponent: string }[] = [];
  for (const file of fs.readdirSync(MAESTRO_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = fs.readFileSync(path.join(MAESTRO_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/id:\s*"opponent-name-input"/.test(line)) return;
      // The text follows the tap that focuses the field.
      const typed = lines
        .slice(index + 1, index + 4)
        .map((next) => /^\s*-\s*inputText:\s*"([^"]+)"/.exec(next)?.[1])
        .find((value) => value !== undefined);
      if (typed) found.push({ flow: file, opponent: typed });
    });
  }
  return found;
}

describe('flow fixtures', () => {
  const typed = opponentsTypedByFlows();

  it('finds the flows that create games', () => {
    // A check that reads nothing passes for the wrong reason.
    expect(typed.length).toBeGreaterThanOrEqual(4);
    expect(typed.map((entry) => entry.flow)).toEqual(
      expect.arrayContaining(['game-lifecycle.yaml', 'game-tracking.yaml', 'live-spectator.yaml'])
    );
  });

  it('the seed removes every game a flow creates', () => {
    const notRemoved = typed.filter((entry) => !FLOW_CREATED_OPPONENTS.includes(entry.opponent));

    expect(notRemoved).toEqual([]);
  });

  it('lists no opponent that no flow creates', () => {
    const created = new Set(typed.map((entry) => entry.opponent));

    expect(FLOW_CREATED_OPPONENTS.filter((opponent) => !created.has(opponent))).toEqual([]);
  });

  it('never names a seeded game', () => {
    // The seed creates games against these; removing them would break
    // guardian-rsvp.yaml and the stats flows.
    const seeded = ['Lakers', 'Celtics', 'Heat', 'Warriors', 'Suns'];

    expect(FLOW_CREATED_OPPONENTS.filter((opponent) => seeded.includes(opponent))).toEqual([]);
  });
});

/** Practice titles typed on the New Practice screen (#33), per flow file. */
function practiceTitlesTypedByFlows(): string[] {
  const found: string[] = [];
  for (const file of fs.readdirSync(MAESTRO_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = fs.readFileSync(path.join(MAESTRO_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/id:\s*"practice-title-input"/.test(line)) return;
      const typed = lines
        .slice(index + 1, index + 4)
        .map((next) => /^\s*-\s*inputText:\s*"([^"]+)"/.exec(next)?.[1])
        .find((value) => value !== undefined);
      if (typed) found.push(typed);
    });
  }
  return found;
}

describe('flow fixtures: practices', () => {
  const typed = practiceTitlesTypedByFlows();

  it('finds the flow that schedules practices', () => {
    expect(typed.length).toBeGreaterThanOrEqual(1);
  });

  it('the seed removes every practice a flow creates, and lists nothing else', () => {
    expect(typed.filter((title) => !FLOW_CREATED_PRACTICE_TITLES.includes(title))).toEqual([]);
    expect(FLOW_CREATED_PRACTICE_TITLES.filter((title) => !typed.includes(title))).toEqual([]);
  });
});
