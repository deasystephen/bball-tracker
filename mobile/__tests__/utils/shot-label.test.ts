/**
 * Tests for utils/shot-label.
 *
 * The single source of truth for SHOT display text used by the tracker's
 * UndoBanner message and the EventTimeline: free throws (points === 1)
 * must render "FT", never "1pt".
 */

import { formatShotDescription, getShotPointsLabel } from '../../utils/shot-label';
import type { ShotMetadata } from '../../types/game';

describe('getShotPointsLabel', () => {
  it('renders a free throw (points 1) as "FT", never "1pt"', () => {
    expect(getShotPointsLabel(1)).toBe('FT');
  });

  it('renders field goals as "<points>pt"', () => {
    expect(getShotPointsLabel(2)).toBe('2pt');
    expect(getShotPointsLabel(3)).toBe('3pt');
  });
});

describe('formatShotDescription', () => {
  const meta = (points: 1 | 2 | 3, made: boolean): ShotMetadata => ({ points, made });

  it('describes made and missed free throws as FT', () => {
    expect(formatShotDescription(meta(1, true))).toBe('FT made');
    expect(formatShotDescription(meta(1, false))).toBe('FT miss');
  });

  it('describes made and missed field goals with their point value', () => {
    expect(formatShotDescription(meta(2, true))).toBe('2pt made');
    expect(formatShotDescription(meta(2, false))).toBe('2pt miss');
    expect(formatShotDescription(meta(3, true))).toBe('3pt made');
    expect(formatShotDescription(meta(3, false))).toBe('3pt miss');
  });

  it('defaults missing metadata to a 2pt miss (legacy events)', () => {
    expect(formatShotDescription(undefined)).toBe('2pt miss');
    expect(formatShotDescription(null)).toBe('2pt miss');
  });
});
