/**
 * Typography system with responsive font sizes
 */

export const typography = {
  // Display (Oswald)
  display: {
    fontFamily: 'Oswald_700Bold',
    fontSize: 64,
    lineHeight: 72,
  },
  displaySmall: {
    fontFamily: 'Oswald_700Bold',
    fontSize: 48,
    lineHeight: 54,
  },

  // Headings
  h1: {
    fontFamily: 'Inter_700Bold',
    fontSize: 34,
    fontWeight: '700' as const,
    lineHeight: 41,
    letterSpacing: 0.37,
  },
  h2: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    fontWeight: '700' as const,
    lineHeight: 34,
    letterSpacing: 0.36,
  },
  h3: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 22,
    fontWeight: '600' as const,
    lineHeight: 28,
    letterSpacing: 0.35,
  },
  h4: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 25,
    letterSpacing: 0.38,
  },

  // Stats
  statNumber: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    lineHeight: 32,
  },
  statLabel: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
  },

  // Body text
  body: {
    fontFamily: 'Inter_400Regular',
    fontSize: 17,
    fontWeight: '400' as const,
    lineHeight: 22,
    letterSpacing: -0.41,
  },
  bodyBold: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    lineHeight: 22,
  },

  // Small text
  caption: {
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 20,
    letterSpacing: -0.24,
  },
  captionBold: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    lineHeight: 18,
  },

  // Tiny text
  footnote: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    lineHeight: 16,
  },
  footnoteBold: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    lineHeight: 16,
  },
} as const;

export type TypographyVariant = keyof typeof typography;
