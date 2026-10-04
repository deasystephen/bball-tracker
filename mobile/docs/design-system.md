# Design System Documentation

## Overview

The Hooplings mobile app includes a comprehensive design system with:
- **Dark Mode Support**: Automatic system detection + user preference
- **Internationalization**: Multi-language support (English, Spanish)
- **Responsive Design**: Optimized for both iPhone and iPad

## Theme System

### Colors

The app uses a semantic color system that adapts to light/dark mode:

```typescript
import { useTheme } from '../hooks/useTheme';

const { colors } = useTheme();
// colors.primary, colors.background, colors.text, etc.
```

**Color Variants:**
- `primary` - Main brand color
- `background` - Main background
- `text` - Primary text color
- `textSecondary` - Secondary text
- `card` - Card background
- `border` - Border color
- `error`, `success`, `warning` - Semantic colors

### Typography

Predefined text styles with responsive sizing:

```typescript
import { ThemedText } from '../components';

<ThemedText variant="h1">Heading 1</ThemedText>
<ThemedText variant="body">Body text</ThemedText>
<ThemedText variant="caption">Small text</ThemedText>
```

**Available Variants** (`theme/typography.ts`):
- `display`, `displaySmall` - Hero numbers and titles
- `h1`, `h2`, `h3`, `h4` - Headings
- `statNumber`, `statLabel` - Stat tiles
- `body`, `bodyBold` - Body text
- `caption`, `captionBold` - Small text
- `footnote`, `footnoteBold` - Tiny text

### Spacing

Consistent spacing system:

```typescript
import { spacing } from '../theme';

padding: spacing.md  // 16px
margin: spacing.lg    // 24px
```

**Available Sizes** (`theme/spacing.ts`):
- `xxs`: 2px
- `xs`: 4px
- `sm`: 8px
- `md`: 16px
- `lg`: 24px
- `xl`: 32px
- `xxl`: 48px
- `xxxl`: 64px

## Responsive Design

### Device Detection

```typescript
import { isTablet, isPhone, getResponsiveValue } from '../utils/responsive';

const columns = getResponsiveValue(1, 2); // 1 on phone, 2 on tablet
const padding = getResponsiveValue(16, 24); // 16px on phone, 24px on tablet
```

### Layout Guidelines

**iPhone (Portrait):**
- Single column layouts
- 16px horizontal padding
- Compact spacing

**iPad (Portrait/Landscape):**
- Multi-column layouts (2-3 columns)
- 24px horizontal padding
- Generous spacing
- Max content width: 1200px (centered)

## Internationalization

### Adding Translations

1. Add keys to `i18n/locales/en.json`
2. Add translations to `i18n/locales/es.json` (and other languages)
3. Use in components:

```typescript
import { useTranslation } from '../i18n';

const { t } = useTranslation();
<Text>{t('common.save')}</Text>
```

### Supported Languages

- English (en) - Default
- Spanish (es)

To add more languages, create new files in `i18n/locales/` and add to `i18n/config.ts`.

## Components

### ThemedView

View component that adapts to theme:

```typescript
import { ThemedView } from '../components';

<ThemedView variant="background">      // Main background (default)
<ThemedView variant="secondary">       // Secondary background
<ThemedView variant="tertiary">        // Tertiary background
<ThemedView variant="card">            // Card background
```

### ThemedText

Text component with typography variants:

```typescript
import { ThemedText } from '../components';

<ThemedText variant="h1" color="primary">Title</ThemedText>
<ThemedText variant="body" color="textSecondary">Description</ThemedText>
```

## Required shared components

Every screen uses these; source-scanning tests fail a PR that does not. The authority is `.claude/rules/mobile.md` and the repo's `docs/architecture/mobile-app.md`; this list only names them:

- `DateTimePickerSheet` for every date or time choice
- `ActionMenu` for every per-row menu (never an `Alert` menu)
- `SortPills` for sort pill rows
- `useTabBarPadding()` for the bottom padding of every scrollable tab screen
- `ErrorState` with `onBack={useGoBack(parent)}` on a pushed screen that replaces itself with an error
- Never put a pressable inside a pressable

## Best Practices

1. **Always use themed components** - Don't use hardcoded colors
2. **Use responsive utilities** - Test on both iPhone and iPad
3. **Use i18n for all text** - Never hardcode strings
4. **Follow spacing system** - Use `spacing` constants
5. **Test dark mode** - Ensure all screens work in both themes

## Example: Complete Screen

```typescript
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { ThemedView, ThemedText } from '../components';
import { useTranslation } from '../i18n';
import { spacing } from '../theme';
import { getHorizontalPadding } from '../utils/responsive';

export default function MyScreen() {
  const { t } = useTranslation();
  const padding = getHorizontalPadding();

  return (
    <ThemedView variant="background" style={styles.container}>
      <ScrollView style={{ padding }} contentContainerStyle={{ gap: spacing.md }}>
        <ThemedText variant="h1">{t('common.title')}</ThemedText>
        <ThemedText variant="body" color="textSecondary">
          {t('common.description')}
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
```
