/**
 * Practice scheduling types (#33). The API is the backend's practice routes:
 * docs/architecture/practice-scheduling.md.
 */

import type { RsvpStatus, RsvpSummary } from './game';

export type PracticeType = 'PRACTICE' | 'OTHER';
export type PracticeStatus = 'SCHEDULED' | 'CANCELLED';
export type PracticeFrequency = 'WEEKLY' | 'BIWEEKLY';

/** One dated session (`GET /practices`, `GET /practices/:id`). */
export interface Practice {
  id: string;
  teamId: string;
  /** `null` for a standalone practice. */
  seriesId: string | null;
  type: PracticeType;
  title: string | null;
  location: string | null;
  notes: string | null;
  /** UTC instant. */
  startsAt: string;
  durationMinutes: number;
  /** IANA zone the session was scheduled in; display uses it. */
  timezone: string;
  status: PracticeStatus;
  cancelledAt: string | null;
  cancelReason: string | null;
  isException: boolean;
  exceptionFields: string[];
  createdAt: string;
  updatedAt: string;
  team: { id: string; name: string };
  series: {
    id: string;
    frequency: PracticeFrequency;
    /** 0 = Sunday … 6 = Saturday. */
    weekdays: number[];
    /** Local "HH:MM" in the series' zone. */
    startTime: string;
    cancelledAt: string | null;
  } | null;
  /** `GET /practices/:id` only. */
  availabilitySummary?: RsvpSummary;
}

export interface PracticeSeries {
  id: string;
  teamId: string;
  type: PracticeType;
  title: string | null;
  location: string | null;
  notes: string | null;
  frequency: PracticeFrequency;
  weekdays: number[];
  /** Local "YYYY-MM-DD". */
  startDate: string;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  endDate: string | null;
  occurrenceCount: number | null;
  cancelledAt: string | null;
  team: { id: string; name: string };
  sessions: { id: string; startsAt: string; status: PracticeStatus }[];
}

export interface PracticeAvailability {
  id: string;
  sessionId: string;
  /** The player the answer is for (a guardian's answer is keyed on the child). */
  userId: string;
  status: RsvpStatus;
  /** `null` for readers who may not see it (roster managers, the player and their guardians may). */
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  user: {
    id: string;
    name: string;
    email?: string | null;
    isManaged: boolean;
    deletedAt: string | null;
  };
}

export interface PracticeFilters {
  teamId?: string;
  status?: PracticeStatus;
  /** ISO instant; there is no server default, so an upcoming view passes one. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** The descriptive fields shared by a session, a series and both edits. */
export interface PracticeDetailsInput {
  type?: PracticeType;
  /** An empty string clears the field. */
  title?: string;
  location?: string;
  notes?: string;
}

export interface CreatePracticeInput extends PracticeDetailsInput {
  teamId: string;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
}

export interface UpdatePracticeInput extends PracticeDetailsInput {
  startsAt?: string;
  durationMinutes?: number;
}

export interface CreatePracticeSeriesInput extends PracticeDetailsInput {
  teamId: string;
  frequency: PracticeFrequency;
  weekdays: number[];
  startDate: string;
  startTime: string;
  durationMinutes: number;
  timezone: string;
  endDate?: string;
  occurrenceCount?: number;
}
