/**
 * Schema Validation Tests
 *
 * These tests ensure that Zod validation schemas correctly accept/reject
 * various ID formats and input values. This catches mismatches between
 * what the database allows and what the API validation accepts.
 */

import { createSeasonSchema, updateSeasonSchema, seasonQuerySchema } from '../../src/api/seasons/schemas';
import { createTeamSchema, updateTeamSchema, teamQuerySchema, addPlayerSchema, addStaffSchema, createManagedPlayerSchema, updateTeamMemberSchema, announcementQuerySchema } from '../../src/api/teams/schemas';
import { playerQuerySchema, updatePlayerSchema } from '../../src/api/players/schemas';
import { createGameSchema, updateGameSchema, createGameEventSchema } from '../../src/api/games/schemas';
import { createInvitationSchema } from '../../src/api/invitations/schemas';
import { playerSeasonStatsQuerySchema } from '../../src/api/stats/schemas';
import { avatarUploadUrlSchema } from '../../src/api/uploads/schemas';

// Test ID formats
const UUID_ID = 'a1b2c3d4-e5f6-4890-a234-567890abcdef';
const CUSTOM_STRING_ID = 'downtown-youth-league';
const CUSTOM_STRING_ID_WITH_NUMBERS = 'warriors-spring-2024';
const EMPTY_STRING = '';

describe('Schema Validation', () => {
  describe('ID Format Acceptance', () => {
    describe('League ID', () => {
      it('should accept UUID format for leagueId in createSeasonSchema', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: 'Spring 2024',
        });
        expect(result.success).toBe(true);
      });

      it('should accept custom string format for leagueId in createSeasonSchema', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: CUSTOM_STRING_ID,
          name: 'Spring 2024',
        });
        expect(result.success).toBe(true);
      });

      it('should accept custom string with numbers for leagueId', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: CUSTOM_STRING_ID_WITH_NUMBERS,
          name: 'Spring 2024',
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty string for leagueId', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: EMPTY_STRING,
          name: 'Spring 2024',
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toContain('League ID is required');
        }
      });

      it('should accept custom string leagueId in seasonQuerySchema', () => {
        const result = seasonQuerySchema.safeParse({
          leagueId: CUSTOM_STRING_ID,
        });
        expect(result.success).toBe(true);
      });

      it('should accept custom string leagueId in teamQuerySchema', () => {
        const result = teamQuerySchema.safeParse({
          leagueId: CUSTOM_STRING_ID,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('Season ID', () => {
      it('should accept UUID format for seasonId in createTeamSchema', () => {
        const result = createTeamSchema.safeParse({
          name: 'Lakers',
          seasonId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });

      it('should reject non-UUID format for seasonId in createTeamSchema', () => {
        const result = createTeamSchema.safeParse({
          name: 'Lakers',
          seasonId: CUSTOM_STRING_ID,
        });
        expect(result.success).toBe(false);
      });

      it('should accept UUID seasonId in teamQuerySchema', () => {
        const result = teamQuerySchema.safeParse({
          seasonId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('Team ID', () => {
      it('should accept UUID format for teamId in createGameSchema', () => {
        const result = createGameSchema.safeParse({
          teamId: UUID_ID,
          opponent: 'Celtics',
          date: '2024-03-15T18:00:00Z',
        });
        expect(result.success).toBe(true);
      });

      it('should reject non-UUID format for teamId in createGameSchema', () => {
        const result = createGameSchema.safeParse({
          teamId: CUSTOM_STRING_ID_WITH_NUMBERS,
          opponent: 'Celtics',
          date: '2024-03-15T18:00:00Z',
        });
        expect(result.success).toBe(false);
      });

      it('should accept UUID teamId in playerSeasonStatsQuerySchema', () => {
        const result = playerSeasonStatsQuerySchema.safeParse({
          teamId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('Player ID', () => {
      it('should accept UUID format for playerId in addPlayerSchema', () => {
        const result = addPlayerSchema.safeParse({
          playerId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });

      it('should reject non-UUID format for playerId in addPlayerSchema', () => {
        const result = addPlayerSchema.safeParse({
          playerId: CUSTOM_STRING_ID,
        });
        expect(result.success).toBe(false);
      });

      it('should accept UUID playerId in createInvitationSchema', () => {
        const result = createInvitationSchema.safeParse({
          playerId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });

      describe('createInvitationSchema create-and-invite (audit #69)', () => {
        it('accepts name + email without playerId', () => {
          const result = createInvitationSchema.safeParse({
            name: '  Jane Hooper ',
            email: 'jane@example.com',
            jerseyNumber: 7,
          });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.name).toBe('Jane Hooper');
            expect(result.data.playerId).toBeUndefined();
            expect(result.data.expiresInDays).toBe(7);
          }
        });

        it('accepts an https profilePictureUrl with name + email', () => {
          const result = createInvitationSchema.safeParse({
            name: 'Jane',
            email: 'jane@example.com',
            profilePictureUrl: 'https://cdn.example.com/a.png',
          });
          expect(result.success).toBe(true);
        });

        it('rejects a body with neither playerId nor name + email', () => {
          expect(createInvitationSchema.safeParse({}).success).toBe(false);
          expect(createInvitationSchema.safeParse({ name: 'Jane' }).success).toBe(false);
          expect(createInvitationSchema.safeParse({ email: 'jane@example.com' }).success).toBe(false);
        });

        it('rejects playerId combined with name/email', () => {
          const result = createInvitationSchema.safeParse({
            playerId: UUID_ID,
            name: 'Jane',
            email: 'jane@example.com',
          });
          expect(result.success).toBe(false);
        });

        it('rejects an invalid email and an empty name', () => {
          expect(createInvitationSchema.safeParse({ name: 'Jane', email: 'nope' }).success).toBe(false);
          expect(createInvitationSchema.safeParse({ name: '   ', email: 'jane@example.com' }).success).toBe(false);
        });

        it('rejects a non-http profilePictureUrl', () => {
          const result = createInvitationSchema.safeParse({
            name: 'Jane',
            email: 'jane@example.com',
            profilePictureUrl: 'ftp://cdn.example.com/a.png',
          });
          expect(result.success).toBe(false);
        });
      });

      it('should accept optional playerId in createGameEventSchema', () => {
        const result = createGameEventSchema.safeParse({
          eventType: 'SHOT',
          playerId: UUID_ID,
        });
        expect(result.success).toBe(true);
      });

      it('should accept undefined playerId in createGameEventSchema', () => {
        const result = createGameEventSchema.safeParse({
          eventType: 'TIMEOUT',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('User ID', () => {
      it('should accept UUID format for userId in addStaffSchema', () => {
        const result = addStaffSchema.safeParse({
          userId: UUID_ID,
          roleName: 'Head Coach',
        });
        expect(result.success).toBe(true);
      });

      it('should reject non-UUID format for userId in addStaffSchema', () => {
        const result = addStaffSchema.safeParse({
          userId: CUSTOM_STRING_ID,
          roleName: 'Head Coach',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Required Fields', () => {
    describe('createSeasonSchema', () => {
      it('should require leagueId', () => {
        const result = createSeasonSchema.safeParse({
          name: 'Spring 2024',
        });
        expect(result.success).toBe(false);
      });

      it('should require name', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
        });
        expect(result.success).toBe(false);
      });

      it('should accept optional dates', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: 'Spring 2024',
        });
        expect(result.success).toBe(true);
      });

      it('should accept dates when provided', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: 'Spring 2024',
          startDate: '2024-03-01',
          endDate: '2024-06-30',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('createTeamSchema', () => {
      it('should require name', () => {
        const result = createTeamSchema.safeParse({
          seasonId: UUID_ID,
        });
        expect(result.success).toBe(false);
      });

      it('should require seasonId', () => {
        const result = createTeamSchema.safeParse({
          name: 'Lakers',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('createGameSchema', () => {
      it('should require teamId', () => {
        const result = createGameSchema.safeParse({
          opponent: 'Celtics',
          date: '2024-03-15T18:00:00Z',
        });
        expect(result.success).toBe(false);
      });

      it('should require opponent', () => {
        const result = createGameSchema.safeParse({
          teamId: UUID_ID,
          date: '2024-03-15T18:00:00Z',
        });
        expect(result.success).toBe(false);
      });

      it('should require date', () => {
        const result = createGameSchema.safeParse({
          teamId: UUID_ID,
          opponent: 'Celtics',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('updateGameSchema', () => {
      it('should reject an empty body', () => {
        const result = updateGameSchema.safeParse({});
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0].message).toBe('At least one field must be provided');
        }
      });

      it('should reject a body with only unknown keys', () => {
        const result = updateGameSchema.safeParse({ foo: 'bar' });
        expect(result.success).toBe(false);
      });

      it('should accept a single known field', () => {
        expect(updateGameSchema.safeParse({ homeScore: 10 }).success).toBe(true);
        expect(updateGameSchema.safeParse({ status: 'FINISHED' }).success).toBe(true);
        expect(updateGameSchema.safeParse({ opponent: 'Celtics' }).success).toBe(true);
      });

      it('should still reject invalid field values', () => {
        expect(updateGameSchema.safeParse({ homeScore: -1 }).success).toBe(false);
        expect(updateGameSchema.safeParse({ status: 'NOPE' }).success).toBe(false);
      });
    });

    describe('createInvitationSchema', () => {
      it('should require playerId', () => {
        const result = createInvitationSchema.safeParse({});
        expect(result.success).toBe(false);
      });
    });

    describe('createGameEventSchema', () => {
      it('should require eventType', () => {
        const result = createGameEventSchema.safeParse({
          playerId: UUID_ID,
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Field Constraints', () => {
    describe('Name length limits', () => {
      it('should reject empty season name', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: '',
        });
        expect(result.success).toBe(false);
      });

      it('should reject season name over 100 characters', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: 'A'.repeat(101),
        });
        expect(result.success).toBe(false);
      });

      it('should accept season name at 100 characters', () => {
        const result = createSeasonSchema.safeParse({
          leagueId: UUID_ID,
          name: 'A'.repeat(100),
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty team name', () => {
        const result = createTeamSchema.safeParse({
          name: '',
          seasonId: UUID_ID,
        });
        expect(result.success).toBe(false);
      });

      it('should reject team name over 100 characters', () => {
        const result = createTeamSchema.safeParse({
          name: 'A'.repeat(101),
          seasonId: UUID_ID,
        });
        expect(result.success).toBe(false);
      });
    });

    describe('Pagination limits', () => {
      it('should enforce minimum limit of 1', () => {
        const result = seasonQuerySchema.safeParse({
          limit: 0,
        });
        expect(result.success).toBe(false);
      });

      it('should enforce maximum limit of 100', () => {
        const result = seasonQuerySchema.safeParse({
          limit: 101,
        });
        expect(result.success).toBe(false);
      });

      it('should enforce minimum offset of 0', () => {
        const result = seasonQuerySchema.safeParse({
          offset: -1,
        });
        expect(result.success).toBe(false);
      });

      it('should accept valid pagination', () => {
        const result = seasonQuerySchema.safeParse({
          limit: 50,
          offset: 100,
        });
        expect(result.success).toBe(true);
      });
    });

    describe('Update schemas allow partial updates', () => {
      it('should accept empty update for season', () => {
        const result = updateSeasonSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('should accept empty update for team', () => {
        const result = updateTeamSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('should accept partial season update', () => {
        const result = updateSeasonSchema.safeParse({
          name: 'Updated Season',
        });
        expect(result.success).toBe(true);
      });

      it('should accept isActive update for season', () => {
        const result = updateSeasonSchema.safeParse({
          isActive: false,
        });
        expect(result.success).toBe(true);
      });

      it('should accept nullable dates in season update', () => {
        const result = updateSeasonSchema.safeParse({
          startDate: null,
          endDate: null,
        });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Event Type Validation', () => {
    const validEventTypes = [
      'SHOT',
      'REBOUND',
      'ASSIST',
      'TURNOVER',
      'FOUL',
      'SUBSTITUTION',
      'STEAL',
      'BLOCK',
      'TIMEOUT',
    ];

    validEventTypes.forEach((eventType) => {
      it(`should accept ${eventType} as valid event type`, () => {
        const result = createGameEventSchema.safeParse({
          eventType,
        });
        expect(result.success).toBe(true);
      });
    });

    it('should reject invalid event type', () => {
      const result = createGameEventSchema.safeParse({
        eventType: 'INVALID_EVENT',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Boolean Coercion in Query Params', () => {
    it('should coerce "true" string to boolean in seasonQuerySchema', () => {
      const result = seasonQuerySchema.safeParse({
        isActive: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(true);
      }
    });

    it('should coerce "false" string to false in seasonQuerySchema', () => {
      const result = seasonQuerySchema.safeParse({
        isActive: 'false',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(false);
      }
    });
  });

  describe('Number Coercion in Query Params', () => {
    it('should coerce string numbers for pagination', () => {
      const result = seasonQuerySchema.safeParse({
        limit: '25',
        offset: '50',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(25);
        expect(result.data.offset).toBe(50);
      }
    });
  });

  describe('Date Coercion', () => {
    it('should accept ISO date string in createSeasonSchema', () => {
      const result = createSeasonSchema.safeParse({
        leagueId: UUID_ID,
        name: 'Spring 2024',
        startDate: '2024-03-01T00:00:00.000Z',
        endDate: '2024-06-30T23:59:59.999Z',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBeInstanceOf(Date);
        expect(result.data.endDate).toBeInstanceOf(Date);
      }
    });

    it('should accept date-only string in createSeasonSchema', () => {
      const result = createSeasonSchema.safeParse({
        leagueId: UUID_ID,
        name: 'Spring 2024',
        startDate: '2024-03-01',
        endDate: '2024-06-30',
      });
      expect(result.success).toBe(true);
    });

    it('should keep explicit null dates as null in createSeasonSchema (not coerce to 1970)', () => {
      const result = createSeasonSchema.safeParse({
        leagueId: UUID_ID,
        name: 'Spring 2024',
        startDate: null,
        endDate: null,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBeNull();
        expect(result.data.endDate).toBeNull();
      }
    });

    it('should keep explicit null dates as null in updateSeasonSchema', () => {
      const result = updateSeasonSchema.safeParse({ startDate: null, endDate: null });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBeNull();
        expect(result.data.endDate).toBeNull();
      }
    });

    it('should leave omitted dates undefined in createSeasonSchema', () => {
      const result = createSeasonSchema.safeParse({ leagueId: UUID_ID, name: 'Spring 2024' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.startDate).toBeUndefined();
        expect(result.data.endDate).toBeUndefined();
      }
    });

    it('should reject an unparseable date string in createSeasonSchema', () => {
      const result = createSeasonSchema.safeParse({
        leagueId: UUID_ID,
        name: 'Spring 2024',
        startDate: 'not-a-date',
      });
      expect(result.success).toBe(false);
    });

    it('should accept ISO date string in createGameSchema', () => {
      const result = createGameSchema.safeParse({
        teamId: UUID_ID,
        opponent: 'Celtics',
        date: '2024-03-15T18:00:00Z',
      });
      expect(result.success).toBe(true);
      // Note: game schema validates but doesn't coerce dates (unlike season schema)
      if (result.success) {
        expect(result.data.date).toBe('2024-03-15T18:00:00Z');
      }
    });

    it('should accept Date object in createGameSchema', () => {
      const date = new Date('2024-03-15T18:00:00Z');
      const result = createGameSchema.safeParse({
        teamId: UUID_ID,
        opponent: 'Celtics',
        date,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.date).toBeInstanceOf(Date);
      }
    });
  });

  describe('Announcement Query Schema', () => {
    it('should default limit to 20 and offset to 0', () => {
      const result = announcementQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ limit: 20, offset: 0 });
      }
    });

    it('should coerce numeric strings', () => {
      const result = announcementQuerySchema.safeParse({ limit: '5', offset: '10' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ limit: 5, offset: 10 });
      }
    });

    it('should reject non-numeric limit', () => {
      expect(announcementQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
    });

    it('should reject limit of 0, limit above 100 and negative offset', () => {
      expect(announcementQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
      expect(announcementQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
      expect(announcementQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    });

    it('should reject fractional values', () => {
      expect(announcementQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    });
  });

  describe('Managed Player Schema', () => {
    describe('createManagedPlayerSchema', () => {
      it('should accept valid managed player with all fields', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Young Player',
          jerseyNumber: 5,
          position: 'PG',
        });
        expect(result.success).toBe(true);
      });

      it('should accept name only (jersey and position optional)', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Young Player',
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty name', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: '',
        });
        expect(result.success).toBe(false);
      });

      it('should reject missing name', () => {
        const result = createManagedPlayerSchema.safeParse({
          jerseyNumber: 5,
        });
        expect(result.success).toBe(false);
      });

      it('should reject name longer than 100 characters', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'A'.repeat(101),
        });
        expect(result.success).toBe(false);
      });

      it('should accept jersey number 0', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          jerseyNumber: 0,
        });
        expect(result.success).toBe(true);
      });

      it('should accept jersey number 99', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          jerseyNumber: 99,
        });
        expect(result.success).toBe(true);
      });

      it('should reject jersey number 100', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          jerseyNumber: 100,
        });
        expect(result.success).toBe(false);
      });

      it('should reject negative jersey number', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          jerseyNumber: -1,
        });
        expect(result.success).toBe(false);
      });

      it('should reject non-integer jersey number', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          jerseyNumber: 5.5,
        });
        expect(result.success).toBe(false);
      });

      it('should reject position longer than 50 characters', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          position: 'A'.repeat(51),
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Player Query Schema (isManaged filter)', () => {
    it('should accept isManaged=true as string', () => {
      const result = playerQuerySchema.safeParse({
        isManaged: 'true',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isManaged).toBe(true);
      }
    });

    it('should accept isManaged=false as string', () => {
      const result = playerQuerySchema.safeParse({
        isManaged: 'false',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isManaged).toBe(false);
      }
    });

    it('should accept omitted isManaged', () => {
      const result = playerQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isManaged).toBeUndefined();
      }
    });
  });

  describe('Avatar Upload URL Schema', () => {
    it('should accept image/jpeg content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'image/jpeg' });
      expect(result.success).toBe(true);
    });

    it('should accept image/png content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'image/png' });
      expect(result.success).toBe(true);
    });

    it('should reject image/gif content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'image/gif' });
      expect(result.success).toBe(false);
    });

    it('should reject image/webp content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'image/webp' });
      expect(result.success).toBe(false);
    });

    it('should reject application/pdf content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'application/pdf' });
      expect(result.success).toBe(false);
    });

    it('should reject empty string content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: '' });
      expect(result.success).toBe(false);
    });

    it('should reject missing content type', () => {
      const result = avatarUploadUrlSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject arbitrary string content type', () => {
      const result = avatarUploadUrlSchema.safeParse({ contentType: 'text/html' });
      expect(result.success).toBe(false);
    });
  });

  describe('Profile Picture URL Validation', () => {
    describe('createManagedPlayerSchema profilePictureUrl', () => {
      it('should accept valid https URL', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/user/image.jpg',
        });
        expect(result.success).toBe(true);
      });

      it('should accept valid http URL', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          profilePictureUrl: 'http://localhost:3000/avatars/test.jpg',
        });
        expect(result.success).toBe(true);
      });

      it('should reject javascript: URI', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          profilePictureUrl: 'javascript:alert(1)',
        });
        expect(result.success).toBe(false);
      });

      it('should reject data: URI', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          profilePictureUrl: 'data:image/png;base64,abc123',
        });
        expect(result.success).toBe(false);
      });

      it('should reject non-URL string', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
          profilePictureUrl: 'not-a-url',
        });
        expect(result.success).toBe(false);
      });

      it('should accept omitted profilePictureUrl', () => {
        const result = createManagedPlayerSchema.safeParse({
          name: 'Player',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('updatePlayerSchema profilePictureUrl', () => {
      it('should accept valid https URL', () => {
        const result = updatePlayerSchema.safeParse({
          profilePictureUrl: 'https://bucket.s3.amazonaws.com/avatars/image.jpg',
        });
        expect(result.success).toBe(true);
      });

      it('should accept empty string to clear avatar', () => {
        const result = updatePlayerSchema.safeParse({
          profilePictureUrl: '',
        });
        expect(result.success).toBe(true);
      });

      it('should reject javascript: URI', () => {
        const result = updatePlayerSchema.safeParse({
          profilePictureUrl: 'javascript:alert(1)',
        });
        expect(result.success).toBe(false);
      });

      it('should reject ftp: URI', () => {
        const result = updatePlayerSchema.safeParse({
          profilePictureUrl: 'ftp://server.com/file.jpg',
        });
        expect(result.success).toBe(false);
      });

      it('should accept omitted profilePictureUrl', () => {
        const result = updatePlayerSchema.safeParse({
          name: 'Updated Name',
        });
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Update Team Member Schema (jersey number boundaries)', () => {
    it('should accept jersey number 0', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: 0 });
      expect(result.success).toBe(true);
    });

    it('should accept jersey number 99', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: 99 });
      expect(result.success).toBe(true);
    });

    it('should accept jersey number 50', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: 50 });
      expect(result.success).toBe(true);
    });

    it('should reject jersey number 100', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: 100 });
      expect(result.success).toBe(false);
    });

    it('should reject negative jersey number', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer jersey number', () => {
      const result = updateTeamMemberSchema.safeParse({ jerseyNumber: 23.5 });
      expect(result.success).toBe(false);
    });

    it('should accept omitted jersey number', () => {
      const result = updateTeamMemberSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept position with jersey number', () => {
      const result = updateTeamMemberSchema.safeParse({
        jerseyNumber: 23,
        position: 'Guard',
      });
      expect(result.success).toBe(true);
    });

    it('should reject position longer than 50 characters', () => {
      const result = updateTeamMemberSchema.safeParse({
        position: 'A'.repeat(51),
      });
      expect(result.success).toBe(false);
    });
  });
});
