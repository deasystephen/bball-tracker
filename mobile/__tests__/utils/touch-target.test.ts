import { MIN_TOUCH_TARGET, touchTargetHitSlop } from '../../utils/touch-target';

describe('touchTargetHitSlop (#772)', () => {
  it('pads a square control to 44pt on every side', () => {
    expect(MIN_TOUCH_TARGET).toBe(44);
    // 22pt icon + 4pt padding = 30pt drawn: 7pt each side.
    expect(touchTargetHitSlop(30)).toEqual({ top: 7, bottom: 7, left: 7, right: 7 });
    // 24pt icon + 8pt padding = 40pt drawn: 2pt each side.
    expect(touchTargetHitSlop(40)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
  });

  it('rounds an odd shortfall up so the target never ends under 44', () => {
    expect(touchTargetHitSlop(37)).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
  });

  it('pads each axis on its own and never goes negative', () => {
    expect(touchTargetHitSlop(60, 34)).toEqual({ top: 5, bottom: 5, left: 0, right: 0 });
    expect(touchTargetHitSlop(48)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});
