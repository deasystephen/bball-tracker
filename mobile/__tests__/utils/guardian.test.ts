/**
 * utils/guardian — client-side guardian (PARENT role) helpers.
 */

import {
  isGuardian,
  guardianChildren,
  guardianChildrenOnTeam,
  isRosteredOn,
  needsDisplayName,
  relationshipLabel,
  GUARDIAN_RELATIONSHIPS,
} from '../../utils/guardian';

const steph = { childId: 'steph', childName: 'Steph Curry', relationship: 'FATHER' as const, isPrimary: true };
const seth = { childId: 'seth', childName: 'Seth Curry', relationship: 'FATHER' as const, isPrimary: true };
const dell = { id: 'dell', name: 'Dell Curry', email: 'dell.curry@example.com', guardianOf: [steph, seth] };

describe('utils/guardian', () => {
  it('isGuardian / guardianChildren read guardianOf, treating undefined as []', () => {
    expect(isGuardian(dell)).toBe(true);
    expect(isGuardian({ id: 'x' })).toBe(false);
    expect(isGuardian({ id: 'x', guardianOf: [] })).toBe(false);
    expect(isGuardian(null)).toBe(false);
    expect(guardianChildren(undefined)).toEqual([]);
    expect(guardianChildren({ guardianOf: null })).toEqual([]);
  });

  it('guardianChildrenOnTeam keeps only children rostered on the team', () => {
    const team = { members: [{ playerId: 'steph' }, { playerId: 'klay' }] };
    expect(guardianChildrenOnTeam(dell, team)).toEqual([steph]);
    expect(guardianChildrenOnTeam(dell, { members: [] })).toEqual([]);
    expect(guardianChildrenOnTeam(dell, undefined)).toEqual([]);
    expect(guardianChildrenOnTeam({ id: 'nobody' }, team)).toEqual([]);
  });

  it('isRosteredOn checks the caller against team.members', () => {
    const team = { members: [{ playerId: 'steph' }] };
    expect(isRosteredOn({ id: 'steph' }, team)).toBe(true);
    expect(isRosteredOn({ id: 'dell' }, team)).toBe(false);
    expect(isRosteredOn(null, team)).toBe(false);
    expect(isRosteredOn({ id: 'steph' }, undefined)).toBe(false);
  });

  describe('needsDisplayName', () => {
    it('is true for a guardian whose name is still the email local part', () => {
      expect(
        needsDisplayName({ name: 'dell.curry', email: 'Dell.Curry@example.com', guardianOf: [steph] })
      ).toBe(true);
    });

    it('is false once a real name is set, or for non-guardians', () => {
      expect(needsDisplayName(dell)).toBe(false);
      expect(needsDisplayName({ name: 'dell.curry', email: 'dell.curry@example.com' })).toBe(false);
      expect(needsDisplayName({ name: 'dell.curry', email: null, guardianOf: [steph] })).toBe(false);
      expect(needsDisplayName(null)).toBe(false);
    });
  });

  it('relationshipLabel maps every relationship and falls back to Guardian', () => {
    expect(GUARDIAN_RELATIONSHIPS).toEqual(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER']);
    expect(relationshipLabel('MOTHER')).toBe('Mother');
    expect(relationshipLabel('FATHER')).toBe('Father');
    expect(relationshipLabel('OTHER')).toBe('Other');
    expect(relationshipLabel('???')).toBe('Guardian');
  });
});
