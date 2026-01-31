/**
 * Tests for useTheme hook and theme colors
 *
 * Note: Due to React Native mocking complexity with jest-expo,
 * we test the underlying theme data and color values directly
 */

import { colors, ColorScheme, Colors } from '../../theme/colors';

describe('Theme Colors', () => {
  describe('light theme', () => {
    const lightColors = colors.light;

    it('should have primary colors defined', () => {
      expect(lightColors.primary).toBe('#007AFF');
      expect(lightColors.primaryDark).toBe('#0051D5');
      expect(lightColors.primaryLight).toBe('#5AC8FA');
    });

    it('should have background colors defined', () => {
      expect(lightColors.background).toBe('#FFFFFF');
      expect(lightColors.backgroundSecondary).toBe('#F2F2F7');
      expect(lightColors.backgroundTertiary).toBe('#E5E5EA');
    });

    it('should have text colors defined', () => {
      expect(lightColors.text).toBe('#000000');
      expect(lightColors.textSecondary).toBe('#3C3C43');
      expect(lightColors.textTertiary).toBe('#8E8E93');
      expect(lightColors.textInverse).toBe('#FFFFFF');
    });

    it('should have semantic colors defined', () => {
      expect(lightColors.success).toBe('#34C759');
      expect(lightColors.warning).toBe('#FF9500');
      expect(lightColors.error).toBe('#FF3B30');
      expect(lightColors.info).toBe('#007AFF');
    });

    it('should have UI element colors defined', () => {
      expect(lightColors.border).toBeDefined();
      expect(lightColors.card).toBeDefined();
      expect(lightColors.inputBackground).toBeDefined();
      expect(lightColors.inputBorder).toBeDefined();
      expect(lightColors.inputPlaceholder).toBeDefined();
    });

    it('should have tab bar colors defined', () => {
      expect(lightColors.tabBarBackground).toBeDefined();
      expect(lightColors.tabBarActive).toBeDefined();
      expect(lightColors.tabBarInactive).toBeDefined();
    });
  });

  describe('dark theme', () => {
    const darkColors = colors.dark;

    it('should have primary colors defined', () => {
      expect(darkColors.primary).toBe('#0A84FF');
      expect(darkColors.primaryDark).toBe('#0051D5');
      expect(darkColors.primaryLight).toBe('#5AC8FA');
    });

    it('should have background colors defined', () => {
      expect(darkColors.background).toBe('#000000');
      expect(darkColors.backgroundSecondary).toBe('#1C1C1E');
      expect(darkColors.backgroundTertiary).toBe('#2C2C2E');
    });

    it('should have text colors defined', () => {
      expect(darkColors.text).toBe('#FFFFFF');
      expect(darkColors.textSecondary).toBe('#EBEBF5');
      expect(darkColors.textTertiary).toBe('#8E8E93');
      expect(darkColors.textInverse).toBe('#000000');
    });

    it('should have semantic colors defined', () => {
      expect(darkColors.success).toBe('#30D158');
      expect(darkColors.warning).toBe('#FF9F0A');
      expect(darkColors.error).toBe('#FF453A');
      expect(darkColors.info).toBe('#0A84FF');
    });

    it('should have UI element colors defined', () => {
      expect(darkColors.border).toBeDefined();
      expect(darkColors.card).toBeDefined();
      expect(darkColors.inputBackground).toBeDefined();
      expect(darkColors.inputBorder).toBeDefined();
      expect(darkColors.inputPlaceholder).toBeDefined();
    });

    it('should have tab bar colors defined', () => {
      expect(darkColors.tabBarBackground).toBeDefined();
      expect(darkColors.tabBarActive).toBeDefined();
      expect(darkColors.tabBarInactive).toBeDefined();
    });
  });

  describe('theme contrast', () => {
    it('should have different backgrounds between light and dark', () => {
      expect(colors.light.background).not.toBe(colors.dark.background);
    });

    it('should have different text colors between light and dark', () => {
      expect(colors.light.text).not.toBe(colors.dark.text);
    });

    it('should have inverse text colors swapped', () => {
      expect(colors.light.textInverse).toBe(colors.dark.text);
      expect(colors.dark.textInverse).toBe(colors.light.text);
    });

    it('should have different card backgrounds', () => {
      expect(colors.light.card).not.toBe(colors.dark.card);
    });
  });

  describe('color type safety', () => {
    it('should export ColorScheme type correctly', () => {
      const lightScheme: ColorScheme = 'light';
      const darkScheme: ColorScheme = 'dark';
      expect(lightScheme).toBe('light');
      expect(darkScheme).toBe('dark');
    });

    it('should have consistent color shape between themes', () => {
      const lightKeys = Object.keys(colors.light).sort();
      const darkKeys = Object.keys(colors.dark).sort();
      expect(lightKeys).toEqual(darkKeys);
    });
  });
});
