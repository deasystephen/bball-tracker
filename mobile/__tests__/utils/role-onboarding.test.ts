/**
 * Tests for utils/role-onboarding — decides whether a freshly authenticated
 * user is routed to the role-select step or straight to Home.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  needsRoleChoice,
  markRoleChosen,
  postLoginRoute,
  roleChosenKey,
  hasPlaceholderName,
  needsNamePrompt,
  markNameAsked,
  nameAskedKey,
  ROLE_ONBOARDING_ROUTE,
  NAME_ONBOARDING_ROUTE,
  HOME_ROUTE,
} from '../../utils/role-onboarding';
import { UserRole } from '../../../shared/types';

describe('role-onboarding', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  describe('hasPlaceholderName', () => {
    it('matches the email local part case-insensitively, trimmed', () => {
      expect(hasPlaceholderName({ name: 'dell.curry', email: 'Dell.Curry@example.com' })).toBe(true);
      expect(hasPlaceholderName({ name: ' Dell.Curry ', email: 'dell.curry@example.com' })).toBe(true);
      expect(hasPlaceholderName({ name: 'Dell Curry', email: 'dell.curry@example.com' })).toBe(false);
    });

    it('is false when name or email is missing', () => {
      expect(hasPlaceholderName({ name: 'dell.curry', email: null })).toBe(false);
      expect(hasPlaceholderName({ name: null, email: 'dell.curry@example.com' })).toBe(false);
      expect(hasPlaceholderName(null)).toBe(false);
      expect(hasPlaceholderName(undefined)).toBe(false);
    });
  });

  describe('display-name prompt for placeholder-named accounts', () => {
    // Guardian-invite account (PARENT) — the original case.
    const placeholderParent = {
      id: 'p1',
      role: UserRole.PARENT,
      name: 'dell.curry',
      email: 'dell.curry@example.com',
    };
    // Plain WorkOS sign-up where AuthKit collected no name (e.g. a coach):
    // syncUser falls back to the email local part.
    const placeholderCoach = {
      id: 'c1',
      role: UserRole.COACH,
      name: 'frank.vogel',
      email: 'frank.vogel@example.com',
    };

    it('routes a guardian whose name is still the email local part to the name step once', async () => {
      await expect(needsNamePrompt(placeholderParent)).resolves.toBe(true);
      await expect(postLoginRoute(placeholderParent)).resolves.toBe(NAME_ONBOARDING_ROUTE);

      await markNameAsked('p1');
      expect(nameAskedKey('p1')).toBe('nameAsked:p1');
      await expect(needsNamePrompt(placeholderParent)).resolves.toBe(false);
      await expect(postLoginRoute(placeholderParent)).resolves.toBe(HOME_ROUTE);
    });

    it('prompts any placeholder-named account, not only guardians', async () => {
      await expect(needsNamePrompt(placeholderCoach)).resolves.toBe(true);
      await expect(postLoginRoute(placeholderCoach)).resolves.toBe(NAME_ONBOARDING_ROUTE);

      await markNameAsked('c1');
      await expect(postLoginRoute(placeholderCoach)).resolves.toBe(HOME_ROUTE);
    });

    it('does not prompt when the name is real', async () => {
      await expect(needsNamePrompt({ ...placeholderParent, name: 'Dell Curry' })).resolves.toBe(false);
      await expect(postLoginRoute({ ...placeholderParent, name: 'Dell Curry' })).resolves.toBe(HOME_ROUTE);
    });

    it('the role step still wins over the name step for a PLAYER', async () => {
      await expect(postLoginRoute({ ...placeholderParent, role: UserRole.PLAYER })).resolves.toBe(
        ROLE_ONBOARDING_ROUTE
      );
    });

    it('treats a storage failure as "do not ask"', async () => {
      jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
      await expect(needsNamePrompt(placeholderParent)).resolves.toBe(false);
    });
  });

  it('asks a PLAYER who has not chosen yet', async () => {
    await expect(needsRoleChoice({ id: 'u1', role: UserRole.PLAYER })).resolves.toBe(true);
    await expect(postLoginRoute({ id: 'u1', role: UserRole.PLAYER })).resolves.toBe(ROLE_ONBOARDING_ROUTE);
  });

  it('does not ask again once the choice is recorded', async () => {
    await markRoleChosen('u1');
    await expect(needsRoleChoice({ id: 'u1', role: UserRole.PLAYER })).resolves.toBe(false);
    await expect(postLoginRoute({ id: 'u1', role: UserRole.PLAYER })).resolves.toBe(HOME_ROUTE);
  });

  it('scopes the flag per user id', async () => {
    await markRoleChosen('u1');
    await expect(needsRoleChoice({ id: 'u2', role: UserRole.PLAYER })).resolves.toBe(true);
    expect(roleChosenKey('u2')).toBe('roleChosen:u2');
  });

  it.each([UserRole.COACH, UserRole.ADMIN, UserRole.PARENT])('never asks a %s', async (role) => {
    await expect(needsRoleChoice({ id: 'u1', role })).resolves.toBe(false);
    await expect(postLoginRoute({ id: 'u1', role })).resolves.toBe(HOME_ROUTE);
  });

  it('sends a missing user home rather than to onboarding', async () => {
    await expect(postLoginRoute(null)).resolves.toBe(HOME_ROUTE);
    await expect(postLoginRoute(undefined)).resolves.toBe(HOME_ROUTE);
  });

  it('falls back to "do not ask" when storage throws', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    await expect(needsRoleChoice({ id: 'u1', role: UserRole.PLAYER })).resolves.toBe(false);
  });

  it('swallows storage errors when recording the choice', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    await expect(markRoleChosen('u1')).resolves.toBeUndefined();
  });
});
