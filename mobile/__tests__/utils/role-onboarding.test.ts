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
  ROLE_ONBOARDING_ROUTE,
  HOME_ROUTE,
} from '../../utils/role-onboarding';
import { UserRole } from '../../../shared/types';

describe('role-onboarding', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
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
