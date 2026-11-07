/**
 * The age screen (#981, part of #980 adults-only accounts).
 *
 * Shown once per account, before anything else, when the API says
 * `user.ageConfirmed: false` (`utils/role-onboarding.ts#postLoginRoute`,
 * `hooks/useAuthRedirect.ts`). The question is neutral in the FTC's sense:
 * free entry of the birth month and year, no default, no hint about a minimum,
 * nothing that nudges towards an answer. A confirmation step repeats the
 * entered month and year so a typo cannot end the account. There is no way
 * back: the stack gesture is off, a hardware back returns to the question, and
 * the answer travels once to `POST /auth/age-confirmation` and is kept nowhere.
 *
 * Old enough: the store flips `ageConfirmed`, the held-back sign-in analytics
 * fire, and the usual post-login route follows. Under the minimum: the server
 * has already undone the sign-in; the session ends at once with no analytics
 * event at all (`clearSession('age_refused')`, which `useAuthRedirect` does not
 * answer with `/login`), the screen explains, and Done goes to sign-in.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Input, SortPills, ThemedText, ThemedView } from '../../components';
import { useAuthActions, useAuthUser } from '../../store/auth-store';
import { useConfirmAge } from '../../hooks/useConfirmAge';
import { log } from '../../services/log';
import { formatMonthName } from '../../utils/format-date';
import { isUnderMinimumAgeError, parseBirthYear } from '../../utils/age-gate';
import { postLoginRoute } from '../../utils/role-onboarding';
import { spacing } from '../../theme';
import { useTranslation } from '../../i18n';

type Step = 'ask' | 'confirm' | 'refused';

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
type MonthKey = `${number}`;

export default function AgeConfirmationScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const user = useAuthUser();
  const { clearSession } = useAuthActions();
  // The user the answer is for; kept so the route after a confirmation can be
  // computed even if the store changed meanwhile.
  const userRef = useRef(user);
  useEffect(() => {
    if (user) userRef.current = user;
  }, [user]);
  const confirmAge = useConfirmAge();
  const [month, setMonth] = useState<number | null>(null);
  const [yearText, setYearText] = useState('');
  const [yearError, setYearError] = useState<string | undefined>();
  const [step, setStep] = useState<Step>('ask');

  const year = parseBirthYear(yearText);
  // Four digits enable Continue; the range is checked on press so an
  // impossible year gets a message instead of a silently disabled button.
  const canContinue = month !== null && yearText.length === 4 && !confirmAge.isPending;

  // A hardware back never leaves the question (FTC: no back-button retry).
  // From the confirmation it returns to the question; elsewhere it does nothing.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'confirm') setStep('ask');
      return true;
    });
    return () => subscription.remove();
  }, [step]);

  const monthOptions = useMemo(
    () => MONTHS.map((value) => ({ key: `${value}` as MonthKey, label: formatMonthName(value) })),
    []
  );

  const handleContinue = () => {
    if (month === null) return;
    if (year === null) {
      setYearError(t('ageOnboarding.yearInvalid'));
      return;
    }
    setYearError(undefined);
    setStep('confirm');
  };

  const handleSubmit = async () => {
    if (month === null || year === null) return;
    try {
      await confirmAge.mutateAsync({ birthMonth: month, birthYear: year });
      // The store now says confirmed; the role and name steps follow as usual.
      const confirmed = userRef.current;
      router.replace(await postLoginRoute(confirmed ? { ...confirmed, ageConfirmed: true } : null));
    } catch (error) {
      if (isUnderMinimumAgeError(error)) {
        // The account is gone on the server. End the session now, so no
        // background request meets a 401 and records a sign-out on an
        // identity that was never recorded; the explanation stays on screen.
        clearSession('age_refused');
        setStep('refused');
        return;
      }
      // The api-client has already reported a network failure or a 5xx (#617);
      // a 4xx is an expected refusal. Nothing more to capture here.
      log.warn('Age confirmation failed', { error });
      Alert.alert(t('ageOnboarding.saveFailedTitle'), t('ageOnboarding.saveFailedBody'));
    }
  };

  const handleDone = () => {
    router.replace('/login');
  };

  if (step === 'refused') {
    return (
      <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
        <View style={styles.header}>
          <ThemedText variant="h1" heading style={styles.title}>
            {t('ageOnboarding.refusedTitle')}
          </ThemedText>
          <ThemedText variant="body" color="textSecondary">
            {t('ageOnboarding.refusedBody')}
          </ThemedText>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button title={t('common.done')} onPress={handleDone} fullWidth size="large" testID="age-refused-done" />
        </View>
      </ThemedView>
    );
  }

  if (step === 'confirm' && month !== null && year !== null) {
    return (
      <ThemedView variant="background" style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
        <View style={styles.header}>
          <ThemedText variant="h1" heading style={styles.title}>
            {t('ageOnboarding.confirmTitle', { month: formatMonthName(month), year })}
          </ThemedText>
          <ThemedText variant="body" color="textSecondary">
            {t('ageOnboarding.confirmBody')}
          </ThemedText>
        </View>
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button
            title={t('ageOnboarding.confirmYes')}
            onPress={handleSubmit}
            loading={confirmAge.isPending}
            disabled={confirmAge.isPending}
            fullWidth
            size="large"
            testID="age-confirm-submit"
          />
          <Button
            title={t('ageOnboarding.confirmChange')}
            variant="outline"
            onPress={() => setStep('ask')}
            disabled={confirmAge.isPending}
            fullWidth
            style={styles.secondary}
            testID="age-confirm-change"
          />
        </View>
      </ThemedView>
    );
  }

  // The year field opens a number pad, which has no Done key on iOS: the
  // footer rides above the keyboard, picking a month dismisses it, and a
  // drag on the content does too, so Continue is always reachable.
  return (
    <ThemedView variant="background" style={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.xl }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={styles.header}>
            <ThemedText variant="h1" heading style={styles.title}>
              {t('ageOnboarding.title')}
            </ThemedText>
            <ThemedText variant="body" color="textSecondary">
              {t('ageOnboarding.subtitle')}
            </ThemedText>
          </View>

          <ThemedText variant="bodyBold" style={styles.fieldLabel}>
            {t('ageOnboarding.monthLabel')}
          </ThemedText>
          <SortPills
            options={monthOptions}
            selected={month === null ? null : (`${month}` as MonthKey)}
            onSelect={(key) => {
              Keyboard.dismiss();
              setMonth(Number(key));
            }}
            labelPrefix={t('ageOnboarding.monthPrefix')}
            style={styles.months}
          />

          <Input
            label={t('ageOnboarding.yearLabel')}
            placeholder={t('ageOnboarding.yearPlaceholder')}
            value={yearText}
            onChangeText={(text) => {
              setYearText(text.replace(/[^0-9]/g, '').slice(0, 4));
              if (yearError) setYearError(undefined);
            }}
            error={yearError}
            keyboardType="number-pad"
            maxLength={4}
            autoCorrect={false}
            testID="age-year-input"
          />
        </ScrollView>

        <View style={[styles.footer, styles.content, { paddingBottom: insets.bottom + spacing.lg }]}>
          <Button
            title={t('ageOnboarding.continue')}
            onPress={handleContinue}
            disabled={!canContinue}
            fullWidth
            size="large"
            testID="age-continue"
          />
        </View>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  flex: { flex: 1 },
  content: { paddingHorizontal: 0 },
  header: { marginBottom: spacing.xl },
  title: { marginBottom: spacing.sm },
  fieldLabel: { marginBottom: spacing.sm },
  months: { flexWrap: 'wrap', marginBottom: spacing.lg },
  footer: { marginTop: 'auto', gap: spacing.sm },
  secondary: { marginTop: spacing.xs },
});
