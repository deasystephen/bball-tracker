import { canCreateTeams } from '../../utils/team-permissions';
import { UserRole } from '../../../shared/types';

describe('canCreateTeams', () => {
  it.each([UserRole.COACH, UserRole.ADMIN])('allows %s', (role) => {
    expect(canCreateTeams(role)).toBe(true);
  });

  it.each([UserRole.PLAYER, UserRole.PARENT, null, undefined, ''])('denies %p', (role) => {
    expect(canCreateTeams(role)).toBe(false);
  });
});
