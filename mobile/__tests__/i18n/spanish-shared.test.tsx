/**
 * Shared components and the tab bar on a Spanish device (#671).
 *
 * These render on every screen, including the ones that were already
 * translated, so an English default here put English on every screen. Each
 * case switches the real i18n instance to `es` and asserts the Spanish copy
 * and the absence of the English it replaced, for both the visible text and
 * the VoiceOver label.
 */

import React from 'react';
import { Platform } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';

import { i18n } from '../../i18n';
import { ActionMenu } from '../../components/ActionMenu';
import { BackButton } from '../../components/BackButton';
import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';
import { ErrorState } from '../../components/ErrorState';
import { SortPills } from '../../components/SortPills';
import { UsageMeter } from '../../components/UsageMeter';
import { rosterStatusLabel } from '../../utils/roster-status';
import { formatInvitationExpiry } from '../../utils/invitation-expiry';
import TabsLayout from '../../app/(tabs)/_layout';

jest.mock('@react-native-community/datetimepicker', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => mockReact.createElement(View, props),
  };
});

// The real navigator needs a navigation container; this one hands the custom
// tab bar a state with the Track tab focused, which is all the bar reads.
jest.mock('expo-router', () => {
  const routes = ['home', 'teams', 'games', 'stats', 'invitations', 'profile'].map((name) => ({
    key: name,
    name,
  }));
  const Tabs = ({ tabBar }: { tabBar: (props: unknown) => React.ReactNode }) =>
    tabBar({ state: { index: 2, routes }, navigation: { navigate: jest.fn() } });
  Tabs.Screen = function Screen() {
    return null;
  };
  return { Tabs, useRouter: () => ({ push: jest.fn(), back: jest.fn() }) };
});

describe('shared components in Spanish (#671)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('es');
  });

  afterEach(async () => {
    // Inside act: the components of the case just run are still mounted and re-render.
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('ErrorState given only a message resolves its title, buttons and region label in Spanish', () => {
    render(<ErrorState message="Sin conexión" onRetry={jest.fn()} onBack={jest.fn()} />);

    expect(screen.getByText('Algo salió mal')).toBeTruthy();
    expect(screen.getByText('Reintentar')).toBeTruthy();
    expect(screen.getByText('Volver')).toBeTruthy();
    expect(screen.getByLabelText('Error: Algo salió mal. Sin conexión')).toBeTruthy();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.queryByText('Try Again')).toBeNull();
  });

  it('ActionMenu closes with "Cerrar" and a Spanish backdrop label', () => {
    render(<ActionMenu visible title="Opciones" items={[]} onClose={jest.fn()} />);

    expect(screen.getByText('Cerrar')).toBeTruthy();
    expect(screen.getByLabelText('Cerrar menú')).toBeTruthy();
    expect(screen.queryByText('Close')).toBeNull();
  });

  it('DateTimePickerSheet toolbar reads Cancelar / Listo', () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      render(
        <DateTimePickerSheet
          visible
          mode="date"
          value={new Date('2026-10-03T18:30:00Z')}
          title="Fecha"
          onConfirm={jest.fn()}
          onCancel={jest.fn()}
        />
      );

      expect(screen.getByText('Cancelar')).toBeTruthy();
      expect(screen.getByText('Listo')).toBeTruthy();
      expect(screen.getByLabelText('Cerrar selector')).toBeTruthy();
      expect(screen.queryByText('Done')).toBeNull();
    } finally {
      Platform.OS = original;
    }
  });

  it('UsageMeter reads "Ilimitado" and "de"', () => {
    render(
      <>
        <UsageMeter label="Equipos" metric={{ count: 3, limit: null, limitReached: false }} />
        <UsageMeter label="Temporadas" metric={{ count: 1, limit: 5, limitReached: false }} />
      </>
    );

    expect(screen.getByText('3 · Ilimitado')).toBeTruthy();
    expect(screen.getByText('1 de 5')).toBeTruthy();
  });

  it('SortPills and BackButton announce Spanish labels', () => {
    render(
      <>
        <BackButton onPress={jest.fn()} />
        <SortPills options={[{ key: 'name', label: 'Nombre' }]} selected="name" onSelect={jest.fn()} />
      </>
    );

    expect(screen.getByLabelText('Volver')).toBeTruthy();
    expect(screen.getByLabelText('Ordenar por Nombre')).toBeTruthy();
  });

  it('the tab bar shows and announces Spanish tab names', () => {
    render(<TabsLayout />);

    expect(screen.getByLabelText('Pestaña Inicio')).toBeTruthy();
    expect(screen.getByLabelText('Pestaña Equipos')).toBeTruthy();
    expect(screen.getByLabelText('Pestaña Registrar partido')).toBeTruthy();
    expect(screen.getByLabelText('Pestaña Estadísticas')).toBeTruthy();
    expect(screen.getByLabelText('Pestaña Perfil')).toBeTruthy();
    expect(screen.queryByLabelText(/tab$/)).toBeNull();
  });

  it('derived roster and invitation labels are Spanish', () => {
    const now = new Date('2026-10-01T00:00:00Z');

    expect(rosterStatusLabel('not_invited')).toBe('Sin invitar');
    expect(formatInvitationExpiry('2026-10-04T12:00:00Z', now)).toBe('Vence en 4 días');
  });
});
