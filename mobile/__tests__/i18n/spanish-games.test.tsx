/**
 * The game tracker and game screens on a Spanish device (#671).
 *
 * Before #671 no file under `components/game/` called `t()`, so a coach with a
 * phone set to Español tracked a game in English: "Select Player", "MADE",
 * "UNDO (5s)", VoiceOver "2-point shot made". Each case switches the real i18n
 * instance to `es` and asserts the Spanish copy, visible and spoken, and the
 * absence of the English it replaced.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react-native';

import { i18n } from '../../i18n';
import { EventTimeline } from '../../components/game/EventTimeline';
import { GameCard } from '../../components/game/GameCard';
import { PlayerRoster } from '../../components/game/PlayerRoster';
import { ScoreDisplay } from '../../components/game/ScoreDisplay';
import { ShotButtons } from '../../components/game/ShotButtons';
import { StatButtons } from '../../components/game/StatButtons';
import { UndoBanner } from '../../components/game/UndoBanner';
import { BoxScoreTable } from '../../components/stats/BoxScoreTable';
import { formatShotDescription } from '../../utils/shot-label';
import type { Game, GameEvent } from '../../types/game';
import type { PlayerGameStats, TeamGameStats } from '../../types/stats';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

const game: Game = {
  id: 'game-1',
  teamId: 'team-1',
  opponent: 'Rivales',
  date: '2026-03-15T19:30:00.000Z',
  status: 'SCHEDULED',
  homeScore: 0,
  awayScore: 0,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
  team: { id: 'team-1', name: 'Halcones' },
};

const event = (id: string, eventType: GameEvent['eventType'], metadata: GameEvent['metadata']): GameEvent => ({
  id,
  gameId: 'game-1',
  playerId: 'p1',
  eventType,
  timestamp: '2026-08-29T19:00:00.000Z',
  metadata,
  createdAt: '2026-08-29T19:00:00.000Z',
  player: { id: 'p1', name: 'Ana López', isManaged: false, deletedAt: null },
});

const stats = {
  points: 12,
  rebounds: 5,
  assists: 3,
  steals: 2,
  blocks: 1,
  turnovers: 2,
  fouls: 1,
  fieldGoalsMade: 5,
  fieldGoalsAttempted: 10,
  fieldGoalPercentage: 50,
  threePointersMade: 1,
  threePointersAttempted: 3,
  threePointPercentage: 33.3,
  freeThrowsMade: 1,
  freeThrowsAttempted: 2,
  freeThrowPercentage: 50,
};

describe('the game tracker in Spanish (#671)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('es');
  });

  afterEach(async () => {
    // Inside act: the components of the case just run are still mounted and re-render.
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('GameCard shows the shared status label "Programado"', () => {
    render(<GameCard game={game} onPress={jest.fn()} />);

    expect(screen.getByText('Programado')).toBeTruthy();
    expect(screen.queryByText('Scheduled')).toBeNull();
  });

  it('PlayerRoster asks to pick a player and reads the jersey number in Spanish', () => {
    render(
      <PlayerRoster
        players={[{ id: 'm1', playerId: 'p1', jerseyNumber: 7, player: { id: 'p1', name: 'Ana López', isManaged: false, deletedAt: null } } as never]}
        selectedPlayerId={null}
        onSelectPlayer={jest.fn()}
      />
    );

    expect(screen.getByText('Selecciona un jugador')).toBeTruthy();
    expect(screen.getByLabelText('Ana López, número 7')).toBeTruthy();
  });

  it('ShotButtons and StatButtons show and announce Spanish plays', () => {
    render(
      <>
        <ShotButtons onShot={jest.fn()} disabled />
        <StatButtons onStat={jest.fn()} />
      </>
    );

    expect(screen.getByLabelText('tiro de 2 puntos anotado')).toBeTruthy();
    expect(screen.getByLabelText('tiro libre fallado')).toBeTruthy();
    expect(screen.getAllByText('ANOTADO').length).toBe(3);
    expect(screen.getByText('Primero selecciona un jugador')).toBeTruthy();
    expect(screen.getByLabelText('Registrar rebote ofensivo')).toBeTruthy();
    expect(screen.getByText('Otras estadísticas')).toBeTruthy();
    expect(screen.queryByText('MADE')).toBeNull();
    expect(screen.queryByLabelText(/^Record /)).toBeNull();
  });

  it('ScoreDisplay labels the score, the badge and End in Spanish', () => {
    render(
      <ScoreDisplay homeTeamName="Halcones" awayTeamName="Rivales" homeScore={3} awayScore={0} onEndGame={jest.fn()} />
    );

    expect(screen.getByText('EN VIVO')).toBeTruthy();
    expect(screen.getByLabelText('Terminar partido')).toBeTruthy();
    expect(screen.getByLabelText('Marcador: Halcones 3, Rivales 0')).toBeTruthy();
  });

  it('UndoBanner counts down in Spanish', () => {
    render(<UndoBanner visible message="Ana - T2 anotado" onUndo={jest.fn()} duration={5} />);

    expect(screen.getByText('DESHACER (5 s)')).toBeTruthy();
    expect(screen.getByLabelText('Deshacer')).toBeTruthy();
  });

  it('EventTimeline describes plays in Spanish', () => {
    render(
      <EventTimeline
        events={[
          event('e1', 'REBOUND', { type: 'offensive' } as never),
          event('e2', 'SHOT', { made: true, points: 1 }),
        ]}
      />
    );

    expect(screen.getByText('Jugadas recientes')).toBeTruthy();
    expect(screen.getByText('2 en total')).toBeTruthy();
    expect(screen.getByText('Rebote ofensivo')).toBeTruthy();
    expect(screen.getByText('TL anotado')).toBeTruthy();
    expect(formatShotDescription({ made: false, points: 3 })).toBe('T3 fallado');
  });

  it('BoxScoreTable heads its columns with Spanish abbreviations', () => {
    const player = { ...stats, playerId: 'p1', playerName: 'Ana López', jerseyNumber: 7 } as PlayerGameStats;
    render(<BoxScoreTable players={[player]} teamStats={stats as TeamGameStats} />);

    expect(screen.getByText('Jugador')).toBeTruthy();
    expect(screen.getByText('ROB')).toBeTruthy();
    expect(screen.getByText('TAP')).toBeTruthy();
    expect(screen.getByText('EQUIPO')).toBeTruthy();
    expect(screen.queryByText('STL')).toBeNull();
  });
});
