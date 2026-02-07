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
      expect(lightColors.primary).toBe('#1A3A5C');
      expect(lightColors.primaryDark).toBe('#0F2540');
      expect(lightColors.primaryLight).toBe('#2E5C8A');
    });

    it('should have background colors defined', () => {
      expect(lightColors.background).toBe('#F8F9FB');
      expect(lightColors.backgroundSecondary).toBe('#FFFFFF');
      expect(lightColors.backgroundTertiary).toBe('#EEF1F5');
    });

    it('should have text colors defined', () => {
      expect(lightColors.text).toBe('#1A1D23');
      expect(lightColors.textSecondary).toBe('#5A6275');
      expect(lightColors.textTertiary).toBe('#9BA3B5');
      expect(lightColors.textInverse).toBe('#FFFFFF');
    });

    it('should have semantic colors defined', () => {
      expect(lightColors.success).toBe('#22C55E');
      expect(lightColors.warning).toBe('#F59E0B');
      expect(lightColors.error).toBe('#EF4444');
      expect(lightColors.info).toBe('#3B82F6');
    });

    it('should have accent colors defined', () => {
      expect(lightColors.accent).toBe('#FF6B35');
      expect(lightColors.accentLight).toBe('#FF8C5E');
      expect(lightColors.accentDark).toBe('#E55A28');
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

    it('should have live indicator colors defined', () => {
      expect(lightColors.live).toBeDefined();
      expect(lightColors.liveBackground).toBeDefined();
    });
  });

  describe('dark theme', () => {
    const darkColors = colors.dark;

    it('should have primary colors defined', () => {
      expect(darkColors.primary).toBe('#4A9EFF');
      expect(darkColors.primaryDark).toBe('#2E5C8A');
      expect(darkColors.primaryLight).toBe('#6BB3FF');
    });

    it('should have background colors defined', () => {
      expect(darkColors.background).toBe('#0D1117');
      expect(darkColors.backgroundSecondary).toBe('#161B22');
      expect(darkColors.backgroundTertiary).toBe('#21262D');
    });

    it('should have text colors defined', () => {
      expect(darkColors.text).toBe('#F0F6FC');
      expect(darkColors.textSecondary).toBe('#8B949E');
      expect(darkColors.textTertiary).toBe('#6E7681');
      expect(darkColors.textInverse).toBe('#0D1117');
    });

    it('should have semantic colors defined', () => {
      expect(darkColors.success).toBe('#3FB950');
      expect(darkColors.warning).toBe('#D29922');
      expect(darkColors.error).toBe('#F85149');
      expect(darkColors.info).toBe('#58A6FF');
    });

    it('should have accent colors defined', () => {
      expect(darkColors.accent).toBe('#FF8C5E');
      expect(darkColors.accentLight).toBe('#FFAB85');
      expect(darkColors.accentDark).toBe('#FF6B35');
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

    it('should have live indicator colors defined', () => {
      expect(darkColors.live).toBeDefined();
      expect(darkColors.liveBackground).toBeDefined();
    });
  });

  describe('theme contrast', () => {
    it('should have different backgrounds between light and dark', () => {
      expect(colors.light.background).not.toBe(colors.dark.background);
    });

    it('should have different text colors between light and dark', () => {
      expect(colors.light.text).not.toBe(colors.dark.text);
    });

    it('should have inverse text colors for readability', () => {
      // Light textInverse should be readable on dark backgrounds
      expect(colors.light.textInverse).toBeDefined();
      // Dark textInverse should be readable on light backgrounds
      expect(colors.dark.textInverse).toBeDefined();
      // They should be different from each other
      expect(colors.light.textInverse).not.toBe(colors.dark.textInverse);
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
