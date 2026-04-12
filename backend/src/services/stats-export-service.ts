/**
 * Stats export service
 *
 * Produces streaming exports of game/team stats in CSV and PDF formats.
 * Consumers pipe the returned stream directly to the HTTP response so
 * we never buffer large outputs in memory.
 */

import { Readable } from 'stream';
import { stringify as csvStringify } from 'csv-stringify';
import PDFDocument from 'pdfkit';
import type { Game, Team } from '@prisma/client';
import prisma from '../models';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { canAccessTeam } from '../utils/permissions';
import { StatsService } from './stats-service';

type GameWithTeam = Game & { team: Team };

/**
 * Slugify a string for safe use in filenames.
 */
export function slugify(input: string): string {
  return (input || '')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'export';
}

/**
 * Format a Date as an ISO date (YYYY-MM-DD) for filenames.
 */
export function formatDateForFilename(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface ExportFile {
  filename: string;
  stream: NodeJS.ReadableStream;
  contentType: string;
}

/**
 * CSV formula-injection guard.
 *
 * Spreadsheet apps (Excel, Google Sheets, Numbers) treat cells whose value
 * starts with `=`, `+`, `-`, or `@` as formulas, which can exfiltrate data or
 * execute DDE commands. Prefix any user-controlled string whose first char
 * matches with a single apostrophe so it renders as literal text.
 *
 * We also guard against leading whitespace + trigger char (e.g. ` =1+1`).
 * Non-string values are passed through unchanged.
 *
 * See OWASP "CSV Injection".
 */
export function escapeCsvCell(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  // Match optional leading whitespace then a trigger character.
  if (/^[\s]*[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

// Page size for cursor-based streaming of game events.
const EVENT_PAGE_SIZE = 500;

export class StatsExportService {
  /**
   * Verify the user can access a game's team.
   * Any team member (player, staff, league admin, system admin) is allowed.
   */
  private static async verifyGameAccess(gameId: string, userId: string): Promise<GameWithTeam> {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { team: true },
    });

    if (!game) {
      throw new NotFoundError('Game not found');
    }

    const hasAccess = await canAccessTeam(userId, game.teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this game');
    }

    return game;
  }

  /**
   * Verify the user can access a team.
   */
  private static async verifyTeamAccess(teamId: string, userId: string): Promise<Team> {
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundError('Team not found');
    }
    const hasAccess = await canAccessTeam(userId, teamId);
    if (!hasAccess) {
      throw new ForbiddenError('You do not have access to this team');
    }
    return team;
  }

  /**
   * Export the full event log for a game as a streaming CSV.
   * One row per game event.
   */
  static async exportGameEventsCsv(gameId: string, userId: string): Promise<ExportFile> {
    const game = await this.verifyGameAccess(gameId, userId);

    const header = [
      'event_id',
      'game_id',
      'team_name',
      'opponent',
      'game_date',
      'timestamp',
      'event_type',
      'player_id',
      'player_name',
      'points',
      'made',
      'rebound_type',
      'metadata_json',
    ];

    const stringifier = csvStringify({ header: true, columns: header });

    // Cache user-controlled strings that are the same across rows.
    const teamName = escapeCsvCell(game.team.name);
    const opponent = escapeCsvCell(game.opponent);

    // Stream rows into the CSV as we paginate via Prisma cursors so we never
    // hold more than EVENT_PAGE_SIZE rows in memory at once. See PR #46 review.
    (async (): Promise<void> => {
      try {
        let cursor: { id: string } | undefined;
        // Deterministic order: timestamp asc, then id asc as a tiebreaker so
        // the cursor advances correctly even when many events share a ts.
        for (;;) {
          const page = await prisma.gameEvent.findMany({
            where: { gameId },
            orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
            include: { player: { select: { id: true, name: true } } },
            take: EVENT_PAGE_SIZE,
            ...(cursor ? { cursor, skip: 1 } : {}),
          });

          if (page.length === 0) break;

          for (const event of page) {
            const metadata = (event.metadata ?? {}) as Record<string, unknown>;
            const points = typeof metadata.points === 'number' ? metadata.points : '';
            const made = typeof metadata.made === 'boolean' ? String(metadata.made) : '';
            const reboundType = typeof metadata.type === 'string' ? metadata.type : '';

            stringifier.write([
              event.id,
              event.gameId,
              teamName,
              opponent,
              game.date.toISOString(),
              event.timestamp.toISOString(),
              event.eventType,
              event.playerId ?? '',
              escapeCsvCell(event.player?.name ?? ''),
              points,
              made,
              escapeCsvCell(reboundType),
              JSON.stringify(metadata),
            ]);
          }

          if (page.length < EVENT_PAGE_SIZE) break;
          cursor = { id: page[page.length - 1].id };
        }
        stringifier.end();
      } catch (err) {
        stringifier.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    const filename = `${slugify(game.team.name)}-${formatDateForFilename(game.date)}-${slugify(game.opponent)}-events.csv`;

    return {
      filename,
      stream: stringifier,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  /**
   * Export a box-score PDF for a game.
   * Uses PDFKit and streams bytes as they are written.
   */
  static async exportGameBoxScorePdf(gameId: string, userId: string): Promise<ExportFile> {
    // Access is re-verified inside getBoxScore, but call it explicitly so we
    // surface the right error before building the PDF.
    await this.verifyGameAccess(gameId, userId);
    const boxScore = await StatsService.getBoxScore(gameId, userId);

    const doc = new PDFDocument({ size: 'LETTER', margin: 40, info: { Title: 'Box Score' } });

    const title = `${boxScore.team.name} vs ${boxScore.game.opponent}`;
    const gameDate = new Date(boxScore.game.date);

    doc.fontSize(18).text(title, { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor('#555').text(
      `${gameDate.toUTCString().slice(0, 16)}  |  Status: ${boxScore.game.status}`
    );
    doc.fillColor('#000');
    doc.moveDown(0.4);
    doc.fontSize(14).text(
      `Score: ${boxScore.team.name} ${boxScore.game.homeScore} - ${boxScore.game.awayScore} ${boxScore.game.opponent}`
    );
    doc.moveDown(0.6);

    // Player table
    const columns: Array<{ label: string; width: number; align?: 'left' | 'right' }> = [
      { label: '#', width: 28, align: 'right' },
      { label: 'Player', width: 140 },
      { label: 'PTS', width: 36, align: 'right' },
      { label: 'REB', width: 36, align: 'right' },
      { label: 'AST', width: 36, align: 'right' },
      { label: 'STL', width: 36, align: 'right' },
      { label: 'BLK', width: 36, align: 'right' },
      { label: 'FG', width: 60, align: 'right' },
      { label: '3P', width: 60, align: 'right' },
      { label: 'FT', width: 60, align: 'right' },
    ];

    const startX = doc.page.margins.left;
    let y = doc.y;

    const drawRow = (cells: string[], opts: { bold?: boolean } = {}): void => {
      if (opts.bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      doc.fontSize(10);
      let x = startX;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        doc.text(cells[i] ?? '', x, y, { width: col.width, align: col.align ?? 'left', lineBreak: false });
        x += col.width;
      }
      y += 16;
      // Page break if we run out of room
      if (y > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
        y = doc.page.margins.top;
      }
    };

    drawRow(columns.map((c) => c.label), { bold: true });
    // Divider
    doc.moveTo(startX, y - 2).lineTo(startX + columns.reduce((s, c) => s + c.width, 0), y - 2).stroke();

    const players = boxScore.team.players;
    if (players.length === 0) {
      doc.font('Helvetica-Oblique').fontSize(10).text('No player stats recorded for this game.', startX, y);
      y += 16;
    } else {
      for (const p of players) {
        drawRow([
          p.jerseyNumber != null ? String(p.jerseyNumber) : '',
          p.playerName,
          String(p.points),
          String(p.rebounds),
          String(p.assists),
          String(p.steals),
          String(p.blocks),
          `${p.fieldGoalsMade}/${p.fieldGoalsAttempted}`,
          `${p.threePointersMade}/${p.threePointersAttempted}`,
          `${p.freeThrowsMade}/${p.freeThrowsAttempted}`,
        ]);
      }
    }

    // Team totals row
    const t = boxScore.team.stats;
    doc.moveTo(startX, y).lineTo(startX + columns.reduce((s, c) => s + c.width, 0), y).stroke();
    y += 4;
    drawRow(
      [
        '',
        'TEAM TOTALS',
        String(t.points),
        String(t.rebounds),
        String(t.assists),
        String(t.steals),
        String(t.blocks),
        `${t.fieldGoalsMade}/${t.fieldGoalsAttempted}`,
        `${t.threePointersMade}/${t.threePointersAttempted}`,
        `${t.freeThrowsMade}/${t.freeThrowsAttempted}`,
      ],
      { bold: true }
    );

    doc.end();

    const filename = `${slugify(boxScore.team.name)}-${formatDateForFilename(gameDate)}-${slugify(boxScore.game.opponent)}-boxscore.pdf`;

    return {
      filename,
      stream: doc as unknown as Readable,
      contentType: 'application/pdf',
    };
  }

  /**
   * Export per-player season aggregates for a team as a streaming CSV.
   */
  static async exportTeamSeasonStatsCsv(teamId: string, userId: string): Promise<ExportFile> {
    const team = await this.verifyTeamAccess(teamId, userId);
    const roster = await StatsService.getTeamRosterStats(teamId, userId);

    const header = [
      'player_id',
      'player_name',
      'jersey_number',
      'position',
      'games_played',
      'points',
      'rebounds',
      'assists',
      'steals',
      'blocks',
      'turnovers',
      'fouls',
      'field_goals_made',
      'field_goals_attempted',
      'field_goal_percentage',
      'three_pointers_made',
      'three_pointers_attempted',
      'three_point_percentage',
      'free_throws_made',
      'free_throws_attempted',
      'free_throw_percentage',
      'points_per_game',
      'rebounds_per_game',
      'assists_per_game',
      'steals_per_game',
      'blocks_per_game',
      'turnovers_per_game',
      'efficiency',
    ];

    const stringifier = csvStringify({ header: true, columns: header });

    for (const p of roster) {
      stringifier.write([
        p.playerId,
        escapeCsvCell(p.playerName),
        p.jerseyNumber ?? '',
        escapeCsvCell(p.position ?? ''),
        p.gamesPlayed,
        p.points,
        p.rebounds,
        p.assists,
        p.steals,
        p.blocks,
        p.turnovers,
        p.fouls,
        p.fieldGoalsMade,
        p.fieldGoalsAttempted,
        p.fieldGoalPercentage,
        p.threePointersMade,
        p.threePointersAttempted,
        p.threePointPercentage,
        p.freeThrowsMade,
        p.freeThrowsAttempted,
        p.freeThrowPercentage,
        p.pointsPerGame,
        p.reboundsPerGame,
        p.assistsPerGame,
        p.stealsPerGame,
        p.blocksPerGame,
        p.turnoversPerGame,
        p.efficiency,
      ]);
    }

    stringifier.end();

    const filename = `${slugify(team.name)}-season-stats.csv`;

    return {
      filename,
      stream: stringifier,
      contentType: 'text/csv; charset=utf-8',
    };
  }
}
