import { describe, expect, it } from 'vitest';
import { AXIS_TICKS, axisMax, axisTime, compactNumber, labelStride, niceStep } from './chartScale.js';

/**
 * The arithmetic that decides whether an axis is readable. The first UI tests in
 * this repository, added when the charts gained axes - the geometry is drawn,
 * but these are the numbers printed next to it, and a wrong one is a chart that
 * lies quietly.
 */

const ticksFor = (peak: number): string[] =>
  Array.from({ length: AXIS_TICKS }, (_, index) => compactNumber((axisMax(peak) * index) / (AXIS_TICKS - 1)));

describe('the value axis', () => {
  /*
   * The defect this exists to prevent: dividing the peak into quarters and
   * rounding gives a chart whose peak is 1 the labels 0, 0, 1, 1, 1 - four ticks
   * that say nothing and one that repeats.
   */
  it('never prints the same label twice', () => {
    for (const peak of [1, 2, 3, 7, 40, 999, 1234, 999_999, 5_000_000]) {
      expect(new Set(ticksFor(peak)).size, `peak ${peak}`).toBe(AXIS_TICKS);
    }
  });

  it('starts at zero and reaches past the peak', () => {
    for (const peak of [1, 9, 250, 31_000]) {
      expect(ticksFor(peak)[0]).toBe('0');
      expect(axisMax(peak)).toBeGreaterThanOrEqual(peak);
    }
  });

  it('never steps by a fraction of a request', () => {
    // Every measure this product charts is a count: requests and bytes. A step
    // of 0.25 requests is not a quantity that exists.
    expect(niceStep(0.2)).toBe(1);
    expect(niceStep(0)).toBe(1);
    expect(axisMax(1)).toBe(4);
  });

  it('rounds up rather than landing exactly on the peak', () => {
    expect(axisMax(7)).toBe(8);
    expect(axisMax(0)).toBe(4);
  });
});

describe('the time axis', () => {
  it('thins labels out so they cannot collide', () => {
    // A day of five minute points on a normal card: 288 points, seven labels
    // fit, so every 42nd one is drawn.
    expect(labelStride(288, 700, 88)).toBe(42);
    expect(labelStride(12, 700, 88)).toBe(2);
    expect(labelStride(3, 700, 88)).toBe(1);
  });

  it('survives an empty series without dividing by zero', () => {
    expect(labelStride(0, 700, 88)).toBe(1);
  });

  it('says only as much as the bucket justifies', () => {
    expect(axisTime('2026-08-21T09:35:00Z', 300, 'en-GB')).toBe('09:35');
    expect(axisTime('2026-08-21T09:00:00Z', 86_400, 'en-GB')).toBe('21 Aug');
    // A weekly bucket showing minutes would claim a precision it does not have.
    expect(axisTime('2026-08-21T09:35:00Z', 604_800, 'en-GB')).not.toContain(':');
  });

  it('passes an unparseable timestamp through rather than inventing one', () => {
    expect(axisTime('not a date', 300)).toBe('not a date');
  });
});

describe('compact numbers', () => {
  it('shortens without losing the magnitude', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber(12_000)).toBe('12k');
    expect(compactNumber(2_500_000)).toBe('2.5M');
  });
});
