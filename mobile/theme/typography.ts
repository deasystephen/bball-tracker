/**
 * Typography system with responsive font sizes
 */

export const typography = {
  // Headings
  h1: {
    fontSize: 34,
    fontWeight: '700' as const,
    lineHeight: 41,
    letterSpacing: 0.37,
  },
  h2: {
    fontSize: 28,
    fontWeight: '700' as const,
    lineHeight: 34,
    letterSpacing: 0.36,
  },
  h3: {
    fontSize: 22,
    fontWeight: '600' as const,
    lineHeight: 28,
    letterSpacing: 0.35,
  },
  h4: {
    fontSize: 20,
    fontWeight: '600' as const,
    lineHeight: 25,
    letterSpacing: 0.38,
  },
  
  // Body text
  body: {
    fontSize: 17,
    fontWeight: '400' as const,
    lineHeight: 22,
    letterSpacing: -0.41,
  },
  bodyBold: {
    fontSize: 17,
    fontWeight: '600' as const,
    lineHeight: 22,
    letterSpacing: -0.41,
  },
  
  // Small text
  caption: {
    fontSize: 15,
    fontWeight: '400' as const,
    lineHeight: 20,
    letterSpacing: -0.24,
  },
  captionBold: {
    fontSize: 15,
    fontWeight: '600' as const,
    lineHeight: 20,
    letterSpacing: -0.24,
  },
  
  // Tiny text
  footnote: {
    fontSize: 13,
    fontWeight: '400' as const,
    lineHeight: 18,
    letterSpacing: -0.08,
  },
  footnoteBold: {
    fontSize: 13,
    fontWeight: '600' as const,
    lineHeight: 18,
    letterSpacing: -0.08,
  },
} as const;

export type TypographyVariant = keyof typeof typography;
