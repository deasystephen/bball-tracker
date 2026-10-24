/**
 * utils/guardian — client-side guardian (PARENT role) helpers.
 */

import {
  isGuardian,
  guardianChildren,
  guardianChildrenOnTeam,
  isRosteredOn,
  relationshipLabel,
  relationshipNoun,
  GUARDIAN_RELATIONSHIPS,
} from '../../utils/guardian';
import { i18n } from '../../i18n';

const steph = { childId: 'steph', childName: 'Steph Curry', childDeletedAt: null, relationship: 'FATHER' as const, isPrimary: true, isManaged: false };
const seth = { childId: 'seth', childName: 'Seth Curry', childDeletedAt: null, relationship: 'FATHER' as const, isPrimary: true, isManaged: false };
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

  it('relationshipLabel maps every relationship and falls back to Guardian', () => {
    expect(GUARDIAN_RELATIONSHIPS).toEqual(['MOTHER', 'FATHER', 'GUARDIAN', 'OTHER']);
    expect(relationshipLabel('MOTHER')).toBe('Mother');
    expect(relationshipLabel('FATHER')).toBe('Father');
    expect(relationshipLabel('OTHER')).toBe('Other');
    expect(relationshipLabel('???')).toBe('Guardian');
  });

  it('relationshipNoun gives the in-sentence form, from its own keys', () => {
    expect(relationshipNoun('FATHER')).toBe('father');
    expect(relationshipNoun('???')).toBe('guardian');
  });

  it('localizes both forms on a Spanish device (#671)', async () => {
    await i18n.changeLanguage('es');
    try {
      expect(relationshipLabel('MOTHER')).toBe('Madre');
      expect(relationshipLabel('???')).toBe('Tutor');
      expect(relationshipNoun('MOTHER')).toBe('madre');
      expect(relationshipNoun('OTHER')).toBe('otro');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
