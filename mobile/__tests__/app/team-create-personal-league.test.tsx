/**
 * Create Team screen — personal-league branch (#442).
 *
 * A coach whose visible leagues are all auto-provisioned personal containers
 * (or who has none at all) never chose the league concept, so the screen shows
 * only the team-name field and submits WITHOUT `seasonId`; the backend then
 * resolves/creates their personal league + season.
 *
 * The branch is "every visible league is personal", never league count — the
 * second-team case below is exactly the one a count test gets wrong.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

import CreateTeamScreen from '../../app/teams/create';
import { useAuthStore } from '../../store/auth-store';
import type { League } from '../../hooks/useLeagues';
import type { Season } from '../../hooks/useSeasons';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
const mockShowToast = jest.fn();
const mockCreateTeam = { mutateAsync: jest.fn(), isPending: false };
let mockLeagues: League[] = [];
let mockSeasons: Season[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ showToast: mockShowToast }) }));
jest.mock('../../hooks/useLeagues', () => ({
  ...jest.requireActual('../../hooks/useLeagues'),
  useLeagues: () => ({ data: mockLeagues, isLoading: false }),
}));
jest.mock('../../hooks/useSeasons', () => ({
  ...jest.requireActual('../../hooks/useSeasons'),
  useSeasons: () => ({ data: { seasons: mockSeasons }, isLoading: false }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useCreateTeam: () => mockCreateTeam,
}));

const makeLeague = (id: string, name: string, isPersonal?: boolean): League => ({
  id,
  name,
  isPersonal,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
});

const makeSeason = (id: string, leagueId: string, name: string): Season => ({
  id,
  leagueId,
  name,
  isActive: true,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
});

const signInAsCoach = () => {
  useAuthStore.setState({
    user: { id: 'coach-1', role: 'COACH', email: 'coach@example.com', name: 'Coach' } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

describe('CreateTeamScreen — personal-league branch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTeam.mutateAsync.mockResolvedValue({ id: 'team-1', name: 'Warriors' });
    mockLeagues = [];
    mockSeasons = [];
    signInAsCoach();
  });

  describe('no leagues at all (brand-new coach, first team)', () => {
    it('renders only the name field — no league/season disclosure', () => {
      const { queryByTestId, getByTestId } = render(<CreateTeamScreen />);

      expect(getByTestId('team-name-input')).toBeTruthy();
      expect(queryByTestId('league-season-disclosure')).toBeNull();
      expect(queryByTestId('league-option-my-teams')).toBeNull();
    });

    it('submits without seasonId', async () => {
      const { getByTestId, getByText } = render(<CreateTeamScreen />);

      fireEvent.changeText(getByTestId('team-name-input'), '  Warriors  ');
      fireEvent.press(getByText('Create'));

      await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockCreateTeam.mutateAsync).toHaveBeenCalledWith({ name: 'Warriors' });
      expect(mockCreateTeam.mutateAsync.mock.calls[0][0]).not.toHaveProperty('seasonId');
      expect(mockRouter.replace).toHaveBeenCalledWith('/teams/team-1');
    });
  });

  describe('second team — the personal league now exists', () => {
    // The list is NON-EMPTY here, so a league-count check would wrongly show
    // the picker for a concept the coach never chose.
    beforeEach(() => {
      mockLeagues = [makeLeague('lg-personal', "Coach's Teams", true)];
      mockSeasons = [makeSeason('se-personal', 'lg-personal', '2026')];
    });

    it('still renders no league/season picker', () => {
      const { queryByTestId, queryByText } = render(<CreateTeamScreen />);

      expect(queryByTestId('league-season-disclosure')).toBeNull();
      expect(queryByTestId('league-option-lg-personal')).toBeNull();
      expect(queryByText("Coach's Teams")).toBeNull();
    });

    it('still submits without seasonId', async () => {
      const { getByTestId, getByText } = render(<CreateTeamScreen />);

      fireEvent.changeText(getByTestId('team-name-input'), 'Second Team');
      fireEvent.press(getByText('Create'));

      await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockCreateTeam.mutateAsync).toHaveBeenCalledWith({ name: 'Second Team' });
    });
  });

  describe('a real league is visible', () => {
    beforeEach(() => {
      mockLeagues = [
        makeLeague('lg-personal', "Coach's Teams", true),
        makeLeague('lg-real', 'Bay Area Youth', false),
      ];
      mockSeasons = [makeSeason('se-real', 'lg-real', 'Fall 2026')];
    });

    it('renders the collapsed League & season disclosure', () => {
      const { getByTestId, queryByTestId } = render(<CreateTeamScreen />);

      expect(getByTestId('league-season-disclosure')).toBeTruthy();
      // Collapsed: the options only appear after tapping it.
      expect(queryByTestId('league-option-my-teams')).toBeNull();
      expect(queryByTestId('league-option-lg-real')).toBeNull();
    });

    it('offers "My teams" as the pre-selected default when expanded', () => {
      const { getByTestId, queryByTestId } = render(<CreateTeamScreen />);

      fireEvent.press(getByTestId('league-season-disclosure'));

      const myTeams = getByTestId('league-option-my-teams');
      expect(myTeams.props.accessibilityState.selected).toBe(true);
      expect(getByTestId('league-option-lg-real').props.accessibilityState.selected).toBe(false);
      // No season list while "My teams" is the choice.
      expect(queryByTestId('season-option-se-real')).toBeNull();
    });

    it('submits without seasonId while the "My teams" default stands', async () => {
      const { getByTestId, getByText } = render(<CreateTeamScreen />);

      fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
      fireEvent.press(getByText('Create'));

      await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockCreateTeam.mutateAsync).toHaveBeenCalledWith({ name: 'Warriors' });
    });

    it('submits the chosen seasonId when a real league + season are picked', async () => {
      const { getByTestId, getByText } = render(<CreateTeamScreen />);

      fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
      fireEvent.press(getByTestId('league-season-disclosure'));
      fireEvent.press(getByTestId('league-option-lg-real'));
      fireEvent.press(getByTestId('season-option-se-real'));
      fireEvent.press(getByText('Create'));

      await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockCreateTeam.mutateAsync).toHaveBeenCalledWith({
        name: 'Warriors',
        seasonId: 'se-real',
      });
    });

    it('never shows the removed dead-end copy', () => {
      const { queryByText, getByTestId } = render(<CreateTeamScreen />);

      fireEvent.press(getByTestId('league-season-disclosure'));

      expect(queryByText('No leagues available. Create a league first.')).toBeNull();
      expect(queryByText('Ask a league admin to create a season first.')).toBeNull();
    });
  });

  describe('member of someone else\'s league who switched to COACH', () => {
    // Exactly one visible league, not personal and not theirs to write into.
    beforeEach(() => {
      mockLeagues = [makeLeague('lg-other', 'Someone Else League', false)];
      mockSeasons = [];
    });

    it('still gives them a valid choice via the "My teams" default', async () => {
      const { getByTestId, getByText } = render(<CreateTeamScreen />);

      fireEvent.press(getByTestId('league-season-disclosure'));
      expect(getByTestId('league-option-my-teams').props.accessibilityState.selected).toBe(true);

      fireEvent.changeText(getByTestId('team-name-input'), 'Warriors');
      fireEvent.press(getByText('Create'));

      await waitFor(() => expect(mockCreateTeam.mutateAsync).toHaveBeenCalledTimes(1));
      expect(mockCreateTeam.mutateAsync).toHaveBeenCalledWith({ name: 'Warriors' });
    });
  });
});
