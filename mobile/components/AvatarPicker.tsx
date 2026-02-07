/**
 * Avatar component with photo picker support
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  TouchableOpacity,
  Alert,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { typography } from '../theme/typography';

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

/**
 * Interactive avatar picker with camera/library support
 */
export const AvatarPicker: React.FC<AvatarPickerProps> = ({
  uri,
  name = '',
  size = 'large',
  onImageSelected,
}) => {
  const { colors } = useTheme();
  const dimension = SIZES[size];

  const pickImage = async (source: 'camera' | 'library') => {
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

  const handlePress = () => {
    const options: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [
      { text: 'Take Photo', onPress: () => pickImage('camera') },
      { text: 'Choose from Library', onPress: () => pickImage('library') },
    ];

    if (uri) {
      options.push({
        text: 'Remove Photo',
        style: 'destructive',
        onPress: () => onImageSelected(null),
      });
    }

    options.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert('Profile Photo', undefined, options);
  };

  return (
    <TouchableOpacity onPress={handlePress} activeOpacity={0.7}>
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
