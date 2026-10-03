/**
 * `reportTeamUserProperties` (#616): the teams list is the source for
 * `team_count`, `is_head_coach` and `is_assistant_coach`. The role flags come
 * only from a page that holds every team; a partial page reports the count.
 */
import { reportTeamUserProperties, type Team } from '../../hooks/useTeams';
import { useAuthStore } from '../../store/auth-store';
import { setUserProperties } from '../../services/analytics';
import { UserRole, type User } from '../../../shared/types';

jest.mock('../../services/analytics', () => ({
  ...jest.requireActual('../../services/analytics'),
  setUserProperties: jest.fn(),
  identifyUser: jest.fn(),
  trackEvent: jest.fn(),
}));

const mockedSet = setUserProperties as jest.Mock;

const me: User = {
  id: 'me',
  email: 'me@example.test',
  name: 'Me',
  role: UserRole.COACH,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function team(id: string, myRoleType?: 'HEAD_COACH' | 'ASSISTANT_COACH' | 'TEAM_MANAGER'): Team {
  const role = (type: string) => ({
    id: `r-${type}`,
    name: type,
    type: type as 'HEAD_COACH',
    canManageTeam: true,
    canManageRoster: true,
    canTrackStats: true,
    canViewStats: true,
    canShareStats: true,
  });
  return {
    id,
    name: `Team ${id}`,
    seasonId: 's1',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    staff: myRoleType
      ? [{ id: `st-${id}`, userId: 'me', user: { id: 'me', name: 'Me' }, role: role(myRoleType) }]
      : [],
  };
}

describe('reportTeamUserProperties', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: me, isAuthenticated: true, accessToken: 't' });
  });

  it('reports count and the staff flags from a complete page', () => {
    reportTeamUserProperties([team('a', 'HEAD_COACH'), team('b'), team('c', 'TEAM_MANAGER')], 3);
    expect(mockedSet).toHaveBeenCalledWith({ team_count: 3, is_head_coach: true, is_assistant_coach: false });
  });

  it('reports only the count from a partial page, so a flag never flaps between page sizes', () => {
    reportTeamUserProperties([team('a'), team('b')], 25);
    expect(mockedSet).toHaveBeenCalledWith({ team_count: 25 });
  });

  it('reads only the caller\'s own staff rows', () => {
    const other: Team = {
      ...team('x'),
      staff: [{ id: 'st', userId: 'someone-else', user: { id: 'someone-else', name: 'Other' }, role: team('x', 'HEAD_COACH').staff![0].role }],
    };
    reportTeamUserProperties([other, team('y', 'ASSISTANT_COACH')], 2);
    expect(mockedSet).toHaveBeenCalledWith({ team_count: 2, is_head_coach: false, is_assistant_coach: true });
  });

  it('does nothing when nobody is signed in (a stale fetch after logout)', () => {
    useAuthStore.setState({ user: null, isAuthenticated: false, accessToken: null });
    reportTeamUserProperties([team('a', 'HEAD_COACH')], 1);
    expect(mockedSet).not.toHaveBeenCalled();
  });
});
