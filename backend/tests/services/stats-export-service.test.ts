/**
 * Stats Export Service Tests
 *
 * Verify CSV row shape/count and that PDF generation does not throw
 * for varied game data (0 events, many events, players with no stats).
 */

import { mockPrisma } from '../setup';
import { StatsExportService, slugify, formatDateForFilename } from '../../src/services/stats-export-service';
import { StatsService } from '../../src/services/stats-service';
import { NotFoundError, ForbiddenError } from '../../src/utils/errors';

// canAccessTeam is queried via prisma in permissions.ts — we mock it for
// simpler access-control setup. The underlying prisma calls still run via the
// mockPrisma client for models the service itself touches.
jest.mock('../../src/utils/permissions', () => ({
  canAccessTeam: jest.fn(),
}));

import { canAccessTeam } from '../../src/utils/permissions';
const mockCanAccessTeam = canAccessTeam as jest.MockedFunction<typeof canAccessTeam>;

const USER_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const GAME_ID = 'c3d4e5f6-a7b8-4012-a456-7890abcdef01';
const TEAM_ID = 'b2c3d4e5-f6a7-4901-a345-67890abcdef0';

function makeGame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GAME_ID,
    teamId: TEAM_ID,
    opponent: 'Celtics',
    date: new Date('2024-03-15T18:00:00Z'),
    status: 'FINISHED',
    homeScore: 85,
    awayScore: 78,
    team: { id: TEAM_ID, name: 'Lakers' },
    ...overrides,
  };
}

function makeEvent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    gameId: GAME_ID,
    playerId: 'p-1',
    eventType: 'SHOT',
    timestamp: new Date('2024-03-15T18:05:00Z'),
    metadata: { made: true, points: 2 },
    player: { id: 'p-1', name: 'John Doe' },
    ...overrides,
  };
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('StatsExportService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanAccessTeam.mockResolvedValue(true);
  });

  describe('slugify', () => {
    it('lowercases and replaces spaces and special chars', () => {
      expect(slugify('Los Angeles Lakers')).toBe('los-angeles-lakers');
      expect(slugify("O'Brien!!")).toBe('o-brien');
      expect(slugify('  multi   space  ')).toBe('multi-space');
    });

    it('returns a fallback for empty input', () => {
      expect(slugify('')).toBe('export');
      expect(slugify('!!!')).toBe('export');
    });
  });

  describe('formatDateForFilename', () => {
    it('formats as YYYY-MM-DD', () => {
      expect(formatDateForFilename(new Date('2024-03-15T18:00:00Z'))).toBe('2024-03-15');
    });
  });

  describe('exportGameEventsCsv', () => {
    it('throws NotFoundError when game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        StatsExportService.exportGameEventsCsv(GAME_ID, USER_ID)
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws ForbiddenError when user lacks access', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());
      mockCanAccessTeam.mockResolvedValue(false);

      await expect(
        StatsExportService.exportGameEventsCsv(GAME_ID, USER_ID)
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('emits header-only CSV when there are zero events', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue([]);

      const file = await StatsExportService.exportGameEventsCsv(GAME_ID, USER_ID);
      const csv = await streamToString(file.stream);

      const lines = csv.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('event_id,game_id,team_name,opponent');
      expect(file.contentType).toBe('text/csv; charset=utf-8');
      expect(file.filename).toBe('lakers-2024-03-15-celtics-events.csv');
    });

    it('emits one row per event and escapes commas/quotes', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(
        makeGame({ opponent: 'Team, "Angry" Dogs' })
      );
      const events = [
        makeEvent('e-1', { eventType: 'SHOT', metadata: { made: true, points: 3 } }),
        makeEvent('e-2', { eventType: 'REBOUND', metadata: { type: 'offensive' } }),
        makeEvent('e-3', { eventType: 'ASSIST', metadata: {} }),
        makeEvent('e-4', { eventType: 'FOUL', playerId: null, player: null, metadata: {} }),
      ];
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(events);

      const file = await StatsExportService.exportGameEventsCsv(GAME_ID, USER_ID);
      const csv = await streamToString(file.stream);

      const lines = csv.trim().split('\n');
      // header + 4 events
      expect(lines).toHaveLength(5);
      // opponent field must be properly quoted (contains comma + double quotes)
      expect(csv).toContain('"Team, ""Angry"" Dogs"');
      // SHOT row contains points and made
      expect(lines[1]).toContain('SHOT');
      expect(lines[1]).toContain(',3,true,');
      // REBOUND row has rebound_type column
      expect(lines[2]).toContain('offensive');
      // FOUL row with null player has empty player columns
      expect(lines[4]).toMatch(/FOUL,,,/);
    });

    it('handles a large number of events without throwing', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());
      const many = Array.from({ length: 250 }, (_, i) =>
        makeEvent(`e-${i}`, {
          eventType: i % 2 === 0 ? 'SHOT' : 'REBOUND',
          metadata: i % 2 === 0 ? { made: i % 3 === 0, points: 2 } : { type: 'defensive' },
        })
      );
      (mockPrisma.gameEvent.findMany as jest.Mock).mockResolvedValue(many);

      const file = await StatsExportService.exportGameEventsCsv(GAME_ID, USER_ID);
      const csv = await streamToString(file.stream);
      const lines = csv.trim().split('\n');
      // header + 250 data rows
      expect(lines).toHaveLength(251);
    });
  });

  describe('exportGameBoxScorePdf', () => {
    const mockBoxScore = {
      game: {
        id: GAME_ID,
        date: '2024-03-15T18:00:00.000Z',
        status: 'FINISHED',
        homeScore: 85,
        awayScore: 78,
        opponent: 'Celtics',
      },
      team: {
        id: TEAM_ID,
        name: 'Lakers',
        stats: {
          teamId: TEAM_ID,
          teamName: 'Lakers',
          points: 85,
          rebounds: 42,
          assists: 23,
          steals: 8,
          blocks: 5,
          turnovers: 12,
          fouls: 18,
          fieldGoalsMade: 32,
          fieldGoalsAttempted: 70,
          fieldGoalPercentage: 45.7,
          threePointersMade: 10,
          threePointersAttempted: 28,
          threePointPercentage: 35.7,
          freeThrowsMade: 11,
          freeThrowsAttempted: 14,
          freeThrowPercentage: 78.6,
        },
        players: [
          {
            playerId: 'p-1',
            playerName: 'John Doe',
            jerseyNumber: 23,
            position: 'Guard',
            points: 25,
            rebounds: 5,
            offensiveRebounds: 1,
            defensiveRebounds: 4,
            assists: 7,
            steals: 2,
            blocks: 1,
            turnovers: 3,
            fouls: 2,
            fieldGoalsMade: 9,
            fieldGoalsAttempted: 18,
            fieldGoalPercentage: 50,
            threePointersMade: 3,
            threePointersAttempted: 7,
            threePointPercentage: 42.9,
            freeThrowsMade: 4,
            freeThrowsAttempted: 5,
            freeThrowPercentage: 80,
          },
        ],
      },
    };

    beforeEach(() => {
      jest.spyOn(StatsService, 'getBoxScore').mockResolvedValue(mockBoxScore as never);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('produces a valid PDF for a game with player stats', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());

      const file = await StatsExportService.exportGameBoxScorePdf(GAME_ID, USER_ID);
      const buf = await streamToBuffer(file.stream);

      // PDF magic bytes
      expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
      expect(buf.length).toBeGreaterThan(500);
      expect(file.contentType).toBe('application/pdf');
      expect(file.filename).toBe('lakers-2024-03-15-celtics-boxscore.pdf');
    });

    it('produces a valid PDF when no players have stats (empty roster row)', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());
      const emptyBox = {
        ...mockBoxScore,
        team: { ...mockBoxScore.team, players: [] },
      };
      (StatsService.getBoxScore as jest.Mock).mockResolvedValue(emptyBox);

      const file = await StatsExportService.exportGameBoxScorePdf(GAME_ID, USER_ID);
      const buf = await streamToBuffer(file.stream);

      expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('produces a valid PDF when many players force a page break', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(makeGame());
      const many = Array.from({ length: 60 }, (_, i) => ({
        ...mockBoxScore.team.players[0],
        playerId: `p-${i}`,
        playerName: `Player ${i}`,
        jerseyNumber: i,
      }));
      const bigBox = { ...mockBoxScore, team: { ...mockBoxScore.team, players: many } };
      (StatsService.getBoxScore as jest.Mock).mockResolvedValue(bigBox);

      const file = await StatsExportService.exportGameBoxScorePdf(GAME_ID, USER_ID);
      const buf = await streamToBuffer(file.stream);

      expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    });

    it('throws NotFoundError when game does not exist', async () => {
      (mockPrisma.game.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        StatsExportService.exportGameBoxScorePdf(GAME_ID, USER_ID)
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('exportTeamSeasonStatsCsv', () => {
    const rosterRow = {
      playerId: 'p-1',
      playerName: 'John Doe',
      jerseyNumber: 23,
      position: 'Guard',
      gamesPlayed: 10,
      points: 250,
      rebounds: 50,
      offensiveRebounds: 0,
      defensiveRebounds: 0,
      assists: 70,
      steals: 20,
      blocks: 10,
      turnovers: 30,
      fouls: 25,
      fieldGoalsMade: 90,
      fieldGoalsAttempted: 180,
      fieldGoalPercentage: 50,
      threePointersMade: 30,
      threePointersAttempted: 70,
      threePointPercentage: 42.9,
      freeThrowsMade: 40,
      freeThrowsAttempted: 50,
      freeThrowPercentage: 80,
      pointsPerGame: 25,
      reboundsPerGame: 5,
      assistsPerGame: 7,
      stealsPerGame: 2,
      blocksPerGame: 1,
      turnoversPerGame: 3,
      efficiency: 28.5,
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('emits header + one row per player', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ id: TEAM_ID, name: 'Lakers' });
      jest.spyOn(StatsService, 'getTeamRosterStats').mockResolvedValue([
        rosterRow,
        { ...rosterRow, playerId: 'p-2', playerName: 'Jane Smith', jerseyNumber: 7, gamesPlayed: 0 },
      ] as never);

      const file = await StatsExportService.exportTeamSeasonStatsCsv(TEAM_ID, USER_ID);
      const csv = await streamToString(file.stream);
      const lines = csv.trim().split('\n');

      expect(lines).toHaveLength(3); // header + 2 players
      expect(lines[0]).toContain('player_id,player_name,jersey_number');
      expect(lines[1]).toContain('John Doe');
      expect(lines[2]).toContain('Jane Smith');
      expect(file.filename).toBe('lakers-season-stats.csv');
    });

    it('emits header only for an empty roster', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ id: TEAM_ID, name: 'Lakers' });
      jest.spyOn(StatsService, 'getTeamRosterStats').mockResolvedValue([] as never);

      const file = await StatsExportService.exportTeamSeasonStatsCsv(TEAM_ID, USER_ID);
      const csv = await streamToString(file.stream);
      const lines = csv.trim().split('\n');

      expect(lines).toHaveLength(1);
    });

    it('throws NotFoundError when team does not exist', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        StatsExportService.exportTeamSeasonStatsCsv(TEAM_ID, USER_ID)
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws ForbiddenError when user lacks access', async () => {
      (mockPrisma.team.findUnique as jest.Mock).mockResolvedValue({ id: TEAM_ID, name: 'Lakers' });
      mockCanAccessTeam.mockResolvedValue(false);

      await expect(
        StatsExportService.exportTeamSeasonStatsCsv(TEAM_ID, USER_ID)
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
