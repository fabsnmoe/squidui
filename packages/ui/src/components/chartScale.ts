/**
 * The arithmetic behind a chart's axes, kept apart from the drawing.
 *
 * Separated so it can be exercised on its own: these are the decisions that
 * make an axis readable or useless, and they are pure functions of the data.
 */

/** How many gridlines an axis carries, the baseline included. */
export const AXIS_TICKS = 5;

/**
 * A step a person would choose: 1, 2, 2.5 or 5 times a power of ten.
 *
 * Without this the axis divides the peak into quarters, and a chart whose peak
 * is 1 gets the labels 0, 0, 1, 1, 1 - four ticks that say nothing and one that
 * repeats.
 *
 * Never below 1, because every measure this product charts is a count of
 * something: requests and bytes. A step of 0.25 requests is not a quantity that
 * exists.
 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 1) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (magnitude * factor >= rough) return magnitude * factor;
  }
  return magnitude * 10;
}

/** The top of the axis: a round step, times the number of intervals. */
export function axisMax(peak: number): number {
  return niceStep(peak / (AXIS_TICKS - 1)) * (AXIS_TICKS - 1);
}

/**
 * How many points to skip between time labels so they never touch.
 *
 * Returning 1 for an empty series keeps the caller from dividing by zero; it
 * draws nothing anyway.
 */
export function labelStride(pointCount: number, plotWidth: number, labelWidth: number): number {
  if (pointCount <= 0) return 1;
  const fits = Math.max(2, Math.floor(plotWidth / labelWidth));
  return Math.max(1, Math.ceil(pointCount / fits));
}

/**
 * A time label as short as the bucket allows. A five minute chart repeating the
 * date under every tick is noise; a weekly one showing minutes claims a
 * precision it does not have.
 */
export function axisTime(at: string, bucketSeconds: number, locale?: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  if (bucketSeconds < 3600) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (bucketSeconds < 86_400) {
    return date.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit' });
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** Rounded to something a person would say out loud. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}
