/**
 * Onboarding welcome carousel - 3 screens introducing the app
 */

import React, { useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../../theme/spacing';
import { typography } from '../../theme/typography';
import { colors as themeColors } from '../../theme/colors';
import { borderRadius } from '../../theme/border-radius';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface OnboardingScreen {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}

const SCREENS: OnboardingScreen[] = [
  {
    icon: 'basketball-outline',
    title: 'Track Every Play',
    description:
      'Record shots, assists, rebounds, and more in real time. Never miss a stat again with our intuitive game tracking.',
  },
  {
    icon: 'stats-chart-outline',
    title: 'Know Your Numbers',
    description:
      'Automatic stat aggregation gives you shooting percentages, averages, and trends. See how you improve over time.',
  },
  {
    icon: 'people-outline',
    title: 'Build Your Team',
    description:
      'Create teams, invite players, manage rosters and schedules. Everything you need to run your league in one place.',
  },
];

const ONBOARDED_KEY = 'hasOnboarded';

export default function OnboardingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  const handleScroll = (event: { nativeEvent: { contentOffset: { x: number } } }) => {
    const x = event.nativeEvent.contentOffset.x;
    const index = Math.round(x / SCREEN_WIDTH);
    setCurrentIndex(index);
  };

  const handleSkip = async () => {
    await completeOnboarding();
  };

  const handleGetStarted = async () => {
    await completeOnboarding();
  };

  const completeOnboarding = async () => {
    await AsyncStorage.setItem(ONBOARDED_KEY, 'true');
    router.replace('/login');
  };

  const isLastScreen = currentIndex === SCREENS.length - 1;

  return (
    <LinearGradient
      colors={[themeColors.light.primary, themeColors.light.primaryDark]}
      style={styles.gradient}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Skip button */}
        {!isLastScreen && (
          <TouchableOpacity
            style={styles.skipButton}
            onPress={handleSkip}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Text style={styles.skipText}>Skip</Text>
          </TouchableOpacity>
        )}

        {/* Carousel */}
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleScroll}
          bounces={false}
          style={styles.scrollView}
        >
          {SCREENS.map((screen, index) => (
            <View key={index} style={[styles.slide, { width: SCREEN_WIDTH }]}>
              <View style={styles.iconContainer}>
                <Ionicons name={screen.icon} size={96} color="#FFFFFF" />
              </View>
              <Text style={styles.title}>{screen.title}</Text>
              <Text style={styles.description}>{screen.description}</Text>
            </View>
          ))}
        </ScrollView>

        {/* Bottom area: dots + button */}
        <View style={[styles.bottomArea, { paddingBottom: insets.bottom + spacing.lg }]}>
          {/* Pagination dots */}
          <View style={styles.dots}>
            {SCREENS.map((_, index) => (
              <View
                key={index}
                style={[
                  styles.dot,
                  index === currentIndex ? styles.dotActive : styles.dotInactive,
                ]}
              />
            ))}
          </View>

          {/* Get Started button (last screen) */}
          {isLastScreen && (
            <TouchableOpacity
              style={styles.getStartedButton}
              onPress={handleGetStarted}
              activeOpacity={0.8}
            >
              <Text style={styles.getStartedText}>Get Started</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  skipButton: {
    position: 'absolute',
    top: 60,
    right: spacing.lg,
    zIndex: 10,
    padding: spacing.sm,
  },
  skipText: {
    ...typography.caption,
    color: 'rgba(255,255,255,0.8)',
  },
  scrollView: {
    flex: 1,
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  iconContainer: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  title: {
    fontFamily: 'Oswald_700Bold',
    fontSize: 32,
    lineHeight: 40,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  description: {
    ...typography.body,
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
    lineHeight: 24,
  },
  bottomArea: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  dots: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
  },
  dotActive: {
    backgroundColor: '#FFFFFF',
    width: 24,
  },
  dotInactive: {
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  getStartedButton: {
    backgroundColor: '#FFFFFF',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    borderRadius: borderRadius.full,
    width: '100%',
    alignItems: 'center',
  },
  getStartedText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 17,
    color: themeColors.light.primary,
  },
});
