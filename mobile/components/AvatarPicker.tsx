/**
 * Avatar component with photo picker support
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { typography } from '../theme/typography';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';

type AvatarSize = 'small' | 'medium' | 'large';

const SIZES: Record<AvatarSize, number> = {
  small: 32,
  medium: 48,
  large: 80,
};

const FONT_SIZES: Record<AvatarSize, number> = {
  small: 12,
  medium: 18,
  large: 28,
};

interface AvatarProps {
  uri?: string | null;
  name?: string;
  size?: AvatarSize;
}

/**
 * Read-only avatar display (for lists, rosters, etc.)
 */
export const Avatar: React.FC<AvatarProps> = ({
  uri,
  name = '',
  size = 'medium',
}) => {
  const { colors } = useTheme();
  const dimension = SIZES[size];
  const fontSize = FONT_SIZES[size];

  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <View
      style={[
        styles.avatar,
        {
          width: dimension,
          height: dimension,
          borderRadius: dimension / 2,
          backgroundColor: colors.primaryLight,
          borderWidth: 2,
          borderColor: colors.primary,
        },
      ]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
          }}
        />
      ) : (
        <Text style={[styles.initials, { fontSize, color: colors.textInverse }]}>
          {initials || '?'}
        </Text>
      )}
    </View>
  );
};

interface AvatarPickerProps extends AvatarProps {
  onImageSelected: (uri: string | null) => void;
}

type PhotoSource = 'camera' | 'library';

/** Longer than the menu's fade-out; only reached if iOS never calls onDismiss. */
const MENU_DISMISS_FALLBACK_MS = 1000;

/**
 * Interactive avatar picker with camera/library support.
 *
 * The photo menu is an `ActionMenu`, never an `Alert` (#669): with a photo
 * set it has three actions plus Close, and Android's `Alert` keeps at most
 * three buttons, which dropped Cancel and left a dialog that Back could not
 * dismiss.
 */
export const AvatarPicker: React.FC<AvatarPickerProps> = ({
  uri,
  name = '',
  size = 'large',
  onImageSelected,
}) => {
  const { colors } = useTheme();
  const dimension = SIZES[size];

  const pickImage = async (source: PhotoSource) => {
    const permissionResult =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permissionResult.granted) {
      Alert.alert(
        'Permission Required',
        `Please allow access to your ${source === 'camera' ? 'camera' : 'photo library'} in Settings.`
      );
      return;
    }

    const launchFn =
      source === 'camera'
        ? ImagePicker.launchCameraAsync
        : ImagePicker.launchImageLibraryAsync;

    const result = await launchFn({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      onImageSelected(result.assets[0].uri);
    }
  };

  const [menuVisible, setMenuVisible] = useState(false);
  // iOS cannot present the camera or library while the menu's modal is still
  // closing, so the choice waits for the menu's onDismiss there. Android has
  // no such restriction (and no onDismiss), so it launches at once. A
  // fallback timer launches anyway if onDismiss never arrives, so a choice is
  // never silently lost; whichever runs first clears the pending source.
  const pendingSource = useRef<PhotoSource | null>(null);
  const dismissFallback = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (dismissFallback.current) clearTimeout(dismissFallback.current);
    },
    []
  );

  const handleMenuDismiss = () => {
    if (dismissFallback.current) {
      clearTimeout(dismissFallback.current);
      dismissFallback.current = null;
    }
    const source = pendingSource.current;
    pendingSource.current = null;
    if (source) void pickImage(source);
  };

  const choose = (source: PhotoSource) => {
    if (Platform.OS === 'ios') {
      pendingSource.current = source;
      dismissFallback.current = setTimeout(handleMenuDismiss, MENU_DISMISS_FALLBACK_MS);
    } else {
      void pickImage(source);
    }
  };

  const menuItems: ActionMenuItem[] = [
    { label: 'Take Photo', onPress: () => choose('camera') },
    { label: 'Choose from Library', onPress: () => choose('library') },
    ...(uri
      ? [{ label: 'Remove Photo', destructive: true, onPress: () => onImageSelected(null) }]
      : []),
  ];

  const handlePress = () => {
    pendingSource.current = null;
    setMenuVisible(true);
  };

  return (
    <>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.7}
        testID="avatar-picker"
      >
        <Avatar uri={uri} name={name} size={size} />
        <View
          style={[
            styles.editBadge,
            {
              backgroundColor: colors.primary,
              borderColor: colors.background,
            },
          ]}
        >
          <Ionicons name="camera" size={dimension < 48 ? 10 : 14} color={colors.textInverse} />
        </View>
      </TouchableOpacity>
      {/* A sibling of the avatar button, never inside it (nested pressables). */}
      <ActionMenu
        visible={menuVisible}
        title="Profile Photo"
        items={menuItems}
        onClose={() => setMenuVisible(false)}
        onDismiss={handleMenuDismiss}
      />
    </>
  );
};

const styles = StyleSheet.create({
  avatar: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  initials: {
    fontFamily: typography.bodyBold.fontFamily,
  },
  editBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
