/**
 * `useConfirmAge`: the age screen's one request (#981): `POST /auth/age-confirmation` with the
 * birth month and year the person entered and the device's region code.
 *
 * On success the account is confirmed: the store flips `ageConfirmed` and
 * fires the sign-in analytics it held back (`completeAgeConfirmation`), then
 * `age_confirmed` is sent. A 403 `under_minimum_age` means the account is
 * gone on the server; the screen ends the session without recording anything
 * (an under-age outcome is never an analytics datum).
 */

import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../services/api-client';
import { trackEvent, AnalyticsEvents } from '../services/analytics';
import { useAuthStore } from '../store/auth-store';
import { deviceRegionCode, type AgeAnswer } from '../utils/age-gate';

export interface AgeConfirmationResponse {
  confirmed: boolean;
  alreadyConfirmed?: boolean;
}

export function useConfirmAge() {
  return useMutation<AgeConfirmationResponse, Error, AgeAnswer>({
    mutationFn: async (answer) => {
      const regionCode = deviceRegionCode();
      const response = await apiClient.post<AgeConfirmationResponse>('/auth/age-confirmation', {
        birthMonth: answer.birthMonth,
        birthYear: answer.birthYear,
        ...(regionCode ? { regionCode } : {}),
      });
      return response.data;
    },
    onSuccess: () => {
      useAuthStore.getState().completeAgeConfirmation();
      trackEvent(AnalyticsEvents.AGE_CONFIRMED);
    },
  });
}
