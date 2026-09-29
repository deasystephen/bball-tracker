/**
 * Profile — "My kids" section for guardians (PARENT role).
 *
 * Renders each child (name + relationship) and opens the child's stats;
 * "Change account type" is hidden whenever `guardianOf` is non-empty.
 */

import { render, fireEvent } from '@testing-library/react-native';

import Profile from '../../app/(tabs)/profile';
import { useAuthStore } from '../../store/auth-store';
import type { GuardianOfEntry } from '../../../shared/types';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('../../services/sentry', () => ({ captureException: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../hooks/useTeams', () => ({
  ...jest.requireActual('../../hooks/useTeams'),
  useTeams: () => ({ data: [] }),
}));
jest.mock('../../hooks/useUsage', () => ({ useUsage: () => ({ data: undefined }) }));
jest.mock('../../hooks/useProfile', () => ({
  useUpdateProfile: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const signIn = (role: 'PLAYER' | 'COACH' | 'PARENT', guardianOf?: GuardianOfEntry[]) => {
  useAuthStore.setState({
    user: { id: 'dell', role, email: 'dell.curry@example.com', name: 'Dell Curry', guardianOf } as never,
    isAuthenticated: true,
    accessToken: 't',
    refreshToken: null,
    isLoading: false,
  });
};

const kids: GuardianOfEntry[] = [
  // Claimed account (has signed in): no "Delete record" for a guardian (#444 D5)
  { childId: 'steph', childName: 'Steph Curry', relationship: 'FATHER', isPrimary: true, isManaged: false, teams: [{ id: 'w', name: 'Warriors' }] },
  // Managed, unclaimed record: the guardian may delete it
  { childId: 'seth', childName: 'Seth Curry', relationship: 'FATHER', isPrimary: false, isManaged: true },
];

describe('Profile "My kids"', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists each child with relationship and opens the child stats on tap', () => {
    signIn('PARENT', kids);
    const { getByText, getByLabelText, queryByText } = render(<Profile />);
    expect(getByText('My kids')).toBeTruthy();
    expect(getByText('Steph Curry')).toBeTruthy();
    expect(getByText('Father · Primary')).toBeTruthy();
    expect(getByText('Seth Curry')).toBeTruthy();

    fireEvent.press(getByLabelText('Steph Curry, Father'));
    expect(mockRouter.push).toHaveBeenCalledWith('/players/steph/stats');
    expect(queryByText('Change account type')).toBeNull();
  });

  it('opens a per-child menu: stats + guardians for a rostered child, "Delete record" only for a managed child (#444)', () => {
    signIn('PARENT', kids);
    const { getByLabelText, getByText, queryByText } = render(<Profile />);

    fireEvent.press(getByLabelText('More options for Steph Curry'));
    expect(getByText('View stats')).toBeTruthy();
    expect(getByText('Manage guardians')).toBeTruthy();
    expect(queryByText("Delete Steph Curry's record")).toBeNull();
    fireEvent.press(getByText('Manage guardians'));
    expect(mockRouter.push).toHaveBeenCalledWith('/teams/w/players/steph/guardians');

    fireEvent.press(getByLabelText('More options for Seth Curry'));
    expect(queryByText('Manage guardians')).toBeNull();
    fireEvent.press(getByText("Delete Seth Curry's record"));
    expect(mockRouter.push).toHaveBeenCalledWith('/account/delete?childId=seth');
  });

  // #583. On iOS an accessible element hides everything inside it from the
  // accessibility tree. The ⋯ button used to sit inside the row's own button,
  // so VoiceOver and Maestro saw the row and never the menu. getByLabelText
  // finds a nested button anyway, which is why the test above passed while the
  // device failed: the nesting has to be asserted.
  it('keeps the ⋯ button outside the row button, so both can be reached (#583)', () => {
    signIn('PARENT', kids);
    const { getByLabelText } = render(<Profile />);

    for (const child of ['Steph Curry', 'Seth Curry']) {
      const ownLabel = `More options for ${child}`;
      const enclosing = new Set<string>();
      for (let node = getByLabelText(ownLabel).parent; node; node = node.parent) {
        const { accessibilityRole, accessibilityLabel, accessible } = node.props;
        const isAccessible = accessibilityRole === 'button' || accessible === true;
        if (isAccessible && accessibilityLabel !== ownLabel) {
          enclosing.add(String(accessibilityLabel ?? '(no label)'));
        }
      }
      expect([...enclosing]).toEqual([]);

      // Both halves keep a 44pt touch target.
      expect(getByLabelText(ownLabel)).toHaveStyle({ minWidth: 44, minHeight: 44 });
      expect(getByLabelText(`${child}, Father`)).toHaveStyle({ minHeight: 44 });
    }
  });

  it('shows the Delete account row under Account and opens the confirmation screen (#444)', () => {
    signIn('PLAYER', []);
    const { getByLabelText } = render(<Profile />);
    fireEvent.press(getByLabelText('Delete account'));
    expect(mockRouter.push).toHaveBeenCalledWith('/account/delete');
  });

  it('hides "Change account type" for a COACH who is also a guardian', () => {
    signIn('COACH', kids);
    const { getByText, queryByText } = render(<Profile />);
    expect(getByText('My kids')).toBeTruthy();
    expect(queryByText('Change account type')).toBeNull();
  });

  it('shows no "My kids" and keeps "Change account type" for a plain PLAYER', () => {
    signIn('PLAYER', []);
    const { queryByText, getByText } = render(<Profile />);
    expect(queryByText('My kids')).toBeNull();
    expect(getByText('Change account type')).toBeTruthy();
  });
});
