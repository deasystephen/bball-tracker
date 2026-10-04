/**
 * AvatarPicker photo menu (#669): an ActionMenu, never an Alert. Android's
 * Alert keeps at most three buttons, so with a photo set the four-button
 * Alert dropped Cancel and could not be dismissed.
 */

import React from 'react';
import { Alert, Modal, Platform } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { AvatarPicker } from '../../components/AvatarPicker';

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const picker = ImagePicker as jest.Mocked<typeof ImagePicker>;
const PHOTO = 'https://cdn.example.test/avatars/u1/photo.jpg';

const openMenu = () => fireEvent.press(screen.getByTestId('avatar-picker'));
const menu = () => screen.UNSAFE_getByType(Modal);

describe('AvatarPicker photo menu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true } as never);
    picker.launchCameraAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cam.jpg' }] } as never);
    picker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///lib.jpg' }] } as never);
    jest.replaceProperty(Platform, 'OS', 'ios');
  });
  afterEach(() => {
    // Restores Platform.OS even when a test fails midway.
    jest.restoreAllMocks();
  });

  it('never opens an Alert menu', () => {
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={jest.fn()} />);
    openMenu();
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('offers Take Photo, Choose from Library and Remove Photo when a photo is set', () => {
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={jest.fn()} />);
    expect(menu().props.visible).toBe(false);

    openMenu();

    expect(menu().props.visible).toBe(true);
    expect(screen.getByText('Profile Photo')).toBeTruthy();
    expect(screen.getByLabelText('Take Photo')).toBeTruthy();
    expect(screen.getByLabelText('Choose from Library')).toBeTruthy();
    expect(screen.getByLabelText('Remove Photo')).toBeTruthy();
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });

  it('leaves out Remove Photo when there is no photo', () => {
    render(<AvatarPicker uri={null} name="Jamie Lee" onImageSelected={jest.fn()} />);
    openMenu();
    expect(screen.getByLabelText('Take Photo')).toBeTruthy();
    expect(screen.getByLabelText('Choose from Library')).toBeTruthy();
    expect(screen.queryByLabelText('Remove Photo')).toBeNull();
  });

  it('Remove Photo clears the photo and closes the menu', () => {
    const onImageSelected = jest.fn();
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={onImageSelected} />);
    openMenu();

    fireEvent.press(screen.getByLabelText('Remove Photo'));

    expect(onImageSelected).toHaveBeenCalledWith(null);
    expect(menu().props.visible).toBe(false);
  });

  it('dismisses with Close, the backdrop and Android Back without changing the photo', () => {
    const onImageSelected = jest.fn();
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={onImageSelected} />);

    openMenu();
    fireEvent.press(screen.getByLabelText('Close'));
    expect(menu().props.visible).toBe(false);

    openMenu();
    fireEvent.press(screen.getByLabelText('Close menu'));
    expect(menu().props.visible).toBe(false);

    openMenu();
    act(() => {
      menu().props.onRequestClose();
    });
    expect(menu().props.visible).toBe(false);

    expect(onImageSelected).not.toHaveBeenCalled();
  });

  it('on iOS opens the library only once the menu has finished closing', async () => {
    const onImageSelected = jest.fn();
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={onImageSelected} />);
    openMenu();

    fireEvent.press(screen.getByLabelText('Choose from Library'));
    expect(menu().props.visible).toBe(false);
    // Presenting while the modal is still dismissing fails on iOS.
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();

    await act(async () => {
      menu().props.onDismiss();
    });

    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(onImageSelected).toHaveBeenCalledWith('file:///lib.jpg');
  });

  it('on iOS re-tapping the avatar during the fade-out drops the earlier choice', async () => {
    jest.useFakeTimers();
    try {
      render(<AvatarPicker uri={null} name="Jamie Lee" onImageSelected={jest.fn()} />);
      openMenu();
      fireEvent.press(screen.getByLabelText('Take Photo'));
      openMenu();
      expect(menu().props.visible).toBe(true);

      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      // The sheet is open again to choose afresh; nothing launched under it.
      expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('on iOS still opens the camera if the dismiss callback never arrives', async () => {
    jest.useFakeTimers();
    try {
      const onImageSelected = jest.fn();
      render(<AvatarPicker uri={null} name="Jamie Lee" onImageSelected={onImageSelected} />);
      openMenu();
      fireEvent.press(screen.getByLabelText('Take Photo'));
      expect(picker.launchCameraAsync).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });

      expect(picker.launchCameraAsync).toHaveBeenCalledTimes(1);
      expect(onImageSelected).toHaveBeenCalledWith('file:///cam.jpg');

      // A late onDismiss does not open it a second time.
      await act(async () => {
        menu().props.onDismiss();
      });
      expect(picker.launchCameraAsync).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('on Android opens the camera straight away', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const onImageSelected = jest.fn();
    render(<AvatarPicker uri={null} name="Jamie Lee" onImageSelected={onImageSelected} />);
    openMenu();

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Take Photo'));
    });

    expect(picker.launchCameraAsync).toHaveBeenCalledTimes(1);
    expect(onImageSelected).toHaveBeenCalledWith('file:///cam.jpg');
  });

  it('on Android opens the library straight away and Remove Photo still clears', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const onImageSelected = jest.fn();
    render(<AvatarPicker uri={PHOTO} name="Jamie Lee" onImageSelected={onImageSelected} />);
    openMenu();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Choose from Library'));
    });
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(onImageSelected).toHaveBeenLastCalledWith('file:///lib.jpg');

    openMenu();
    fireEvent.press(screen.getByLabelText('Remove Photo'));
    expect(onImageSelected).toHaveBeenLastCalledWith(null);
    expect(menu().props.visible).toBe(false);
  });

  it('keeps the one-button permission Alert when access is denied', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    picker.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: false } as never);
    render(<AvatarPicker uri={null} name="Jamie Lee" onImageSelected={jest.fn()} />);
    openMenu();
    fireEvent.press(screen.getByLabelText('Choose from Library'));

    await act(async () => {
      menu().props.onDismiss();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Permission Required',
      expect.stringContaining('photo library')
    );
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
