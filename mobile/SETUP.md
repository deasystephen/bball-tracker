# Mobile App Setup Guide

## Required Dependencies

Dependencies have been added to `package.json`. Install them with:

```bash
cd mobile
npm install
```

## Features Included

### 1. Theme System (Dark Mode)
- ✅ Light and dark color palettes
- ✅ Automatic system theme detection
- ✅ User preference persistence
- ✅ Themed components (`ThemedView`, `ThemedText`)

**Usage:**
```tsx
import { useTheme } from '../hooks/useTheme';
import { ThemedView, ThemedText } from '../components';

function MyScreen() {
  const { colors } = useTheme();
  
  return (
    <ThemedView variant="background">
      <ThemedText variant="h1">Hello</ThemedText>
    </ThemedView>
  );
}
```

### 2. Internationalization (i18n)
- ✅ English and Spanish translations
- ✅ Automatic device locale detection
- ✅ Easy to add more languages

**Usage:**
```tsx
import { useTranslation } from '../i18n';

function MyScreen() {
  const { t } = useTranslation();
  
  return <Text>{t('common.save')}</Text>;
}
```

### 3. Responsive Design
- ✅ iPhone and iPad support
- ✅ Automatic layout adjustments
- ✅ Responsive spacing and typography

**Usage:**
```tsx
import { isTablet, getResponsiveValue, getHorizontalPadding } from '../utils/responsive';

function MyScreen() {
  const padding = getHorizontalPadding();
  const columns = getResponsiveValue(1, 2); // 1 column on phone, 2 on tablet
  
  return <View style={{ padding }}>...</View>;
}
```

## Project Structure

```
mobile/
├── theme/              # Theme system (colors, spacing, typography)
├── i18n/              # Internationalization
│   ├── config.ts       # i18n configuration
│   └── locales/       # Translation files
├── components/         # Reusable themed components
├── hooks/              # Custom hooks (useTheme, etc.)
├── utils/              # Utilities (responsive, etc.)
└── store/              # Zustand stores (theme, auth)
```

## Next Steps

1. Install dependencies (see above)
2. Start building management UI screens using the theme system
3. Add more translations as needed
4. Create responsive layouts for iPhone and iPad
