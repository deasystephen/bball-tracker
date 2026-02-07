/**
 * Jest setup file for React Native testing
 * Sets up mocks for native modules and common dependencies
 */

import '@testing-library/react-native/extend-expect';

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
  }),
  useLocalSearchParams: () => ({}),
  usePathname: () => '/',
  useSegments: () => [],
  Link: ({ children }) => children,
  Stack: {
    Screen: () => null,
  },
  Tabs: {
    Screen: () => null,
  },
}));

// Mock expo-linking
jest.mock('expo-linking', () => ({
  createURL: jest.fn((path) => `myapp://${path}`),
  parse: jest.fn(),
  openURL: jest.fn(),
}));

// Mock expo-localization
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en', countryCode: 'US' }],
  locale: 'en-US',
  timezone: 'America/New_York',
}));

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => {
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children }) => children,
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
  };
});

// Mock @expo/vector-icons
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const MockIcon = (props) => React.createElement('Text', props, props.name);
  return {
    Ionicons: MockIcon,
    MaterialIcons: MockIcon,
    FontAwesome: MockIcon,
    Feather: MockIcon,
  };
});

// Mock react-native-reanimated
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const View = require('react-native').View;
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (component) => component,
      View: View,
      Text: require('react-native').Text,
      ScrollView: require('react-native').ScrollView,
      call: jest.fn(),
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    useDerivedValue: (fn) => ({ value: fn() }),
    useAnimatedRef: () => ({ current: null }),
    withSpring: (val) => val,
    withTiming: (val) => val,
    withRepeat: (val) => val,
    withSequence: (...vals) => vals[0],
    withDelay: (_, val) => val,
    interpolate: jest.fn(),
    interpolateColor: jest.fn(() => '#000000'),
    Easing: { linear: (v) => v, out: (fn) => fn, cubic: (v) => v, bezier: () => (v) => v },
    FadeIn: { duration: () => ({ delay: () => ({}) }) },
    FadeInLeft: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    Layout: { duration: () => ({}) },
    SlideInUp: { duration: () => ({}) },
    BounceIn: {},
    runOnJS: (fn) => fn,
    runOnUI: (fn) => fn,
    createAnimatedComponent: (component) => component,
  };
});

// Mock expo-linear-gradient
jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  return {
    LinearGradient: ({ children, ...props }) =>
      React.createElement('View', props, children),
  };
});

// Mock expo-blur
jest.mock('expo-blur', () => {
  const React = require('react');
  return {
    BlurView: ({ children, ...props }) =>
      React.createElement('View', props, children),
  };
});

// Mock expo-haptics
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// Mock expo-image-picker
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(() => ({ status: 'granted' })),
  requestMediaLibraryPermissionsAsync: jest.fn(() => ({ status: 'granted' })),
  MediaTypeOptions: { Images: 'Images' },
}));

// Mock react-native-confetti-cannon
jest.mock('react-native-confetti-cannon', () => {
  const React = require('react');
  return React.forwardRef((props, ref) => React.createElement('View', { ...props, ref }));
});

// Mock moti
jest.mock('moti', () => {
  const React = require('react');
  return {
    MotiView: ({ children, ...props }) =>
      React.createElement('View', props, children),
    AnimatePresence: ({ children }) => children,
  };
});

// Mock react-native-svg
jest.mock('react-native-svg', () => {
  const React = require('react');
  const mockComponent = (name) => {
    const Component = ({ children, ...props }) =>
      React.createElement(name, props, children);
    Component.displayName = name;
    return Component;
  };
  return {
    __esModule: true,
    default: mockComponent('Svg'),
    Svg: mockComponent('Svg'),
    Circle: mockComponent('Circle'),
    Rect: mockComponent('Rect'),
    Path: mockComponent('Path'),
    Line: mockComponent('Line'),
    G: mockComponent('G'),
    Text: mockComponent('SvgText'),
    Defs: mockComponent('Defs'),
    LinearGradient: mockComponent('SvgLinearGradient'),
    Stop: mockComponent('Stop'),
  };
});

// Mock expo-splash-screen
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(),
  hideAsync: jest.fn(),
}));

// Mock expo-google-fonts
jest.mock('@expo-google-fonts/inter', () => ({
  useFonts: () => [true, null],
  Inter_400Regular: 'Inter_400Regular',
  Inter_500Medium: 'Inter_500Medium',
  Inter_600SemiBold: 'Inter_600SemiBold',
  Inter_700Bold: 'Inter_700Bold',
}));

jest.mock('@expo-google-fonts/oswald', () => ({
  Oswald_700Bold: 'Oswald_700Bold',
}));

// Note: TanStack Query is NOT mocked globally to allow proper hook testing
// Individual component tests can mock it as needed

// Mock API client
jest.mock('./services/api-client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// Silence console warnings during tests
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === 'string' &&
    (args[0].includes('componentWillReceiveProps') ||
      args[0].includes('componentWillMount') ||
      args[0].includes('Animated: `useNativeDriver`'))
  ) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

// Global test utilities
global.testUtils = {
  // Helper to wait for async operations
  flushPromises: () => new Promise((resolve) => setImmediate(resolve)),

  // Helper to create mock navigation
  createMockNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    reset: jest.fn(),
    setParams: jest.fn(),
    dispatch: jest.fn(),
    isFocused: jest.fn(() => true),
    canGoBack: jest.fn(() => true),
  }),
};
