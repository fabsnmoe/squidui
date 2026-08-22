import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AXIS_TICKS, axisMax, axisTime, compactNumber, labelStride } from './chartScale.js';

/**
 * The chart forms this product needs, drawn as inline SVG.
 *
 * No charting dependency: these are rectangles, polylines and arcs, and a
 * library would add a supply chain and a second design language for the sake of
 * geometry we can write down.
 *
 * The reader picks the form, because the same series answers different
 * questions depending on how it is drawn - composition, comparison or trend.
 * One form is deliberately kept apart from the others: a share chart collapses
 * time entirely, so it answers a different question rather than the same one
 * differently, and the control says so.
 *
 * Geometry is measured in real pixels rather than a scaled viewBox. A viewBox
 * stretched to the container is simpler, but it scales the text with it, so the
 * axis labels would be a different size on every screen - and it distorts
 * stroke weights and turns markers into ellipses.
 */

export interface SeriesDefinition {
  key: string;
  label: string;
  /** A CSS colour, normally a var(--chart-*) reference. */
  color: string;
}

export interface TimePoint {
  at: string;
  values: Record<string, number>;
}

export type ChartForm = 'stacked' | 'grouped' | 'line' | 'area' | 'share';

export interface TimeSeriesChartProps {
  points: readonly TimePoint[];
  series: readonly SeriesDefinition[];
  format?: (value: number) => string;
  /** Names what is being counted; read out to screen readers. */
  caption: string;
  /** Bucket width, so the time labels can be as short as the range allows. */
  bucketSeconds?: number;
  /** Remembers the reader's choice of form across visits. */
  storageKey?: string;
  defaultForm?: ChartForm;
}

const HEIGHT = 280;
/**
 * Room for the value labels on the left and the time labels underneath.
 *
 * The left gutter was measured rather than guessed: at 11px in this typeface the
 * widest label a byte axis produces is around 48px, so 66 leaves the label 58px
 * and a margin instead of touching the edge.
 */
const PAD = { top: 14, right: 14, bottom: 30, left: 66 };
/** A surface gap between adjacent fills, so neighbouring segments stay separable. */
const GAP = 2;
const MIN_SEGMENT = 1;
/** Part-to-whole is legible at a glance only up to a handful of segments. */
const MAX_SHARE_SEGMENTS = 6;
const TICKS = Array.from({ length: AXIS_TICKS }, (_, index) => index / (AXIS_TICKS - 1));
/** Roughly how many time labels fit before they start touching. */
const X_LABEL_WIDTH = 88;

const defaultFormat = (value: number): string => value.toLocaleString();

interface Geometry {
  width: number;
  plotW: number;
  plotH: number;
  step: number;
  base: number;
  y: (value: number) => number;
  centreX: (index: number) => number;
}

function shortTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const FORMS: Array<{ value: ChartForm; label: string; hint: string }> = [
  { value: 'stacked', label: 'Stacked', hint: 'How the total is made up, over time' },
  { value: 'grouped', label: 'Grouped', hint: 'Series compared against each other, period by period' },
  { value: 'line', label: 'Line', hint: 'The trend of each series' },
  { value: 'area', label: 'Area', hint: 'Composition over time, as a continuous shape' },
  { value: 'share', label: 'Share', hint: 'The whole period as one total — time is not shown' },
];

export function TimeSeriesChart({
  points,
  series,
  format = defaultFormat,
  caption,
  bucketSeconds = 3600,
  storageKey,
  defaultForm = 'stacked',
}: TimeSeriesChartProps): JSX.Element {
  const [form, setForm] = useState<ChartForm>(defaultForm);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [width, setWidth] = useState(760);
  const wrapper = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Measured rather than assumed: the labels are drawn at a fixed pixel size, so
  // the plot has to know its real width to place them.
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return undefined;
    const measure = (): void => setWidth(Math.max(320, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    const stored = window.localStorage.getItem(`scp.chart.${storageKey}`);
    if (stored && FORMS.some((entry) => entry.value === stored)) setForm(stored as ChartForm);
  }, [storageKey]);

  const choose = (next: ChartForm): void => {
    setForm(next);
    if (storageKey) window.localStorage.setItem(`scp.chart.${storageKey}`, next);
  };

  const totals = points.map((point) => series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0));
  const stackedPeak = Math.max(1, ...totals, 1);
  const singlePeak = Math.max(
    1,
    ...points.flatMap((point) => series.map((entry) => point.values[entry.key] ?? 0)),
    1,
  );
  const rawPeak = form === 'stacked' || form === 'area' ? stackedPeak : singlePeak;
  // The axis tops out at a round multiple of a round step, so the four ticks
  // below it are all numbers rather than rounding artefacts of the data.
  // The axis tops out at a round multiple of a round step, so the four ticks
  // below it are all numbers rather than rounding artefacts of the data.
  const peak = axisMax(rawPeak);

  const plotW = Math.max(80, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const geo: Geometry = {
    width,
    plotW,
    plotH,
    step: plotW / Math.max(1, points.length),
    base: PAD.top + plotH,
    y: (value) => PAD.top + plotH - (value / peak) * plotH,
    centreX: (index) => PAD.left + (index + 0.5) * (plotW / Math.max(1, points.length)),
  };

  const shareTotals = series.map((entry) => ({
    entry,
    total: points.reduce((sum, point) => sum + (point.values[entry.key] ?? 0), 0),
  }));
  const grandTotal = shareTotals.reduce((sum, item) => sum + item.total, 0);

  // Every nth label, so they never collide however many points there are.
  const stride = labelStride(points.length, plotW, X_LABEL_WIDTH);

  return (
    <div className="scp-chart" ref={wrapper}>
      <div className="scp-chart-forms" role="group" aria-label={`Chart form for ${caption}`}>
        {FORMS.map((entry) => {
          const disabled = entry.value === 'share' && series.length > MAX_SHARE_SEGMENTS;
          return (
            <button
              key={entry.value}
              type="button"
              className="scp-chart-form"
              aria-pressed={form === entry.value}
              disabled={disabled}
              title={disabled ? `Too many series to read as slices; up to ${MAX_SHARE_SEGMENTS} works.` : entry.hint}
              onClick={() => choose(entry.value)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {form === 'share' ? (
        <p className="scp-hint">
          The whole selected period as one total. Time is not shown — switch to another form to see when it
          happened.
        </p>
      ) : null}

      {points.length === 0 ? (
        <p className="scp-hint">Nothing was recorded in this range.</p>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width={width}
          height={HEIGHT}
          role="img"
          aria-labelledby={titleId}
          className="scp-chart-svg"
        >
          <title id={titleId}>{caption}</title>

          {form === 'share' ? (
            <ShareArcs items={shareTotals} total={grandTotal} format={format} geo={geo} />
          ) : (
            <>
              {/* Value axis. The line and its label are one thing: a gridline
                  without a number is decoration. */}
              {TICKS.map((fraction) => {
                const value = peak * fraction;
                return (
                  <g key={fraction}>
                    <line
                      x1={PAD.left}
                      x2={PAD.left + plotW}
                      y1={geo.y(value)}
                      y2={geo.y(value)}
                      stroke="var(--chart-grid)"
                      strokeWidth={1}
                    />
                    <text
                      x={PAD.left - 8}
                      y={geo.y(value) + 4}
                      textAnchor="end"
                      className="scp-chart-axis-label"
                    >
                      {format === defaultFormat ? compactNumber(value) : format(value)}
                    </text>
                  </g>
                );
              })}

              {/* Time axis. Every nth point, plus the last one, so the reader
                  always knows where the chart ends. */}
              {points.map((point, index) => {
                const isLast = index === points.length - 1;
                if (index % stride !== 0 && !isLast) return null;
                // Drop a regular tick that would collide with the final one:
                // where the chart ends matters more than an even spacing.
                const lastX = geo.centreX(points.length - 1);
                if (!isLast && lastX - geo.centreX(index) < X_LABEL_WIDTH * 0.8) return null;
                const x = Math.min(
                  Math.max(geo.centreX(index), PAD.left + 18),
                  PAD.left + plotW - 18,
                );
                return (
                  <text
                    key={`x-${point.at}`}
                    x={x}
                    y={HEIGHT - 10}
                    textAnchor="middle"
                    className="scp-chart-axis-label"
                  >
                    {axisTime(point.at, bucketSeconds)}
                  </text>
                );
              })}

              {form === 'stacked' || form === 'grouped'
                ? points.map((point, index) => (
                    <Bars
                      key={point.at}
                      point={point}
                      series={series}
                      grouped={form === 'grouped'}
                      x={PAD.left + index * geo.step}
                      geo={geo}
                      peak={peak}
                    />
                  ))
                : null}

              {form === 'line' || form === 'area'
                ? series.map((entry, seriesIndex) => (
                    <Trace
                      key={entry.key}
                      entry={entry}
                      seriesIndex={seriesIndex}
                      series={series}
                      points={points}
                      area={form === 'area'}
                      geo={geo}
                    />
                  ))
                : null}

              {points.map((point, index) => (
                <rect
                  key={`hit-${point.at}`}
                  x={PAD.left + index * geo.step}
                  y={PAD.top}
                  width={geo.step}
                  height={plotH}
                  fill={hover === index ? 'var(--color-surface-hover)' : 'transparent'}
                  opacity={hover === index ? 0.6 : 1}
                  tabIndex={0}
                  role="presentation"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                />
              ))}
            </>
          )}
        </svg>
      )}

      {hover !== null && points[hover] && form !== 'share' ? (
        <div className="scp-chart-tooltip" role="status">
          <div className="scp-chart-tooltip-title">{shortTime(points[hover].at)}</div>
          {series.map((entry) => (
            <div key={entry.key} className="scp-chart-tooltip-row">
              <span className="scp-chart-swatch" style={{ background: entry.color }} aria-hidden="true" />
              <span>{entry.label}</span>
              <span className="scp-numeric">{format(points[hover]?.values[entry.key] ?? 0)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {series.length > 1 ? (
        <div className="scp-chart-legend">
          {series.map((entry) => (
            <span key={entry.key} className="scp-chart-legend-item">
              <span className="scp-chart-swatch" style={{ background: entry.color }} aria-hidden="true" />
              {entry.label}
              {form === 'share' && grandTotal > 0 ? (
                <span className="scp-hint">
                  {' '}
                  {(((shareTotals.find((item) => item.entry.key === entry.key)?.total ?? 0) / grandTotal) * 100).toFixed(
                    1,
                  )}
                  {' %'}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <button type="button" className="scp-chart-toggle" onClick={() => setShowTable((open) => !open)}>
        {showTable ? 'Hide the numbers' : 'Show the numbers'}
      </button>

      {showTable ? (
        <div className="scp-table-scroll">
          <table className="scp-table">
            <caption className="scp-hint">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                {series.map((entry) => (
                  <th key={entry.key} scope="col">
                    {entry.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.at}>
                  <th scope="row">{shortTime(point.at)}</th>
                  {series.map((entry) => (
                    <td key={entry.key} className="scp-numeric">
                      {format(point.values[entry.key] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

/** Kept for callers that always want composition over time. */
export const StackedTimeChart = TimeSeriesChart;

/* -------------------------------------------------------------------------- */

function Bars({
  point,
  series,
  grouped,
  x,
  geo,
  peak,
}: {
  point: TimePoint;
  series: readonly SeriesDefinition[];
  grouped: boolean;
  x: number;
  geo: Geometry;
  peak: number;
}): JSX.Element {
  const slotWidth = geo.step * 0.72;

  if (grouped) {
    const each = Math.max(1, (slotWidth - GAP * (series.length - 1)) / series.length);
    return (
      <g>
        {series.map((entry, index) => {
          const value = point.values[entry.key] ?? 0;
          const height = Math.max(value > 0 ? MIN_SEGMENT : 0, (value / peak) * geo.plotH);
          if (height <= 0) return null;
          return (
            <rect
              key={entry.key}
              x={x + (geo.step - slotWidth) / 2 + index * (each + GAP)}
              y={geo.base - height}
              width={each}
              height={height}
              fill={entry.color}
              rx={2}
            />
          );
        })}
      </g>
    );
  }

  let cursor = geo.base;
  return (
    <g>
      {series.map((entry) => {
        const value = point.values[entry.key] ?? 0;
        if (value <= 0) return null;
        const raw = (value / peak) * geo.plotH;
        const height = Math.max(MIN_SEGMENT, raw - GAP);
        cursor -= height + GAP;
        return (
          <rect
            key={entry.key}
            x={x + (geo.step - slotWidth) / 2}
            y={cursor}
            width={slotWidth}
            height={height}
            fill={entry.color}
            rx={2}
          />
        );
      })}
    </g>
  );
}

function Trace({
  entry,
  seriesIndex,
  series,
  points,
  area,
  geo,
}: {
  entry: SeriesDefinition;
  seriesIndex: number;
  series: readonly SeriesDefinition[];
  points: readonly TimePoint[];
  area: boolean;
  geo: Geometry;
}): JSX.Element {
  const below = (index: number): number =>
    series
      .slice(0, seriesIndex)
      .reduce((sum, other) => sum + (points[index]?.values[other.key] ?? 0), 0);
  const valueAt = (index: number): number =>
    (points[index]?.values[entry.key] ?? 0) + (area ? below(index) : 0);

  const top = points.map((_, index) => `${geo.centreX(index)},${geo.y(valueAt(index))}`).join(' ');

  return (
    <g>
      {area ? (
        <polygon
          points={`${top} ${points
            .map((_, index) => {
              const reversed = points.length - 1 - index;
              return `${geo.centreX(reversed)},${geo.y(below(reversed))}`;
            })
            .join(' ')}`}
          fill={entry.color}
          opacity={0.85}
          stroke="var(--color-surface)"
          strokeWidth={GAP}
        />
      ) : (
        <polyline points={top} fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" />
      )}
      {!area && points.length <= 40
        ? points.map((_, index) => (
            <circle
              key={index}
              cx={geo.centreX(index)}
              cy={geo.y(valueAt(index))}
              r={4}
              fill={entry.color}
              stroke="var(--color-surface)"
              strokeWidth={GAP}
            />
          ))
        : null}
    </g>
  );
}

function ShareArcs({
  items,
  total,
  format,
  geo,
}: {
  items: Array<{ entry: SeriesDefinition; total: number }>;
  total: number;
  format: (value: number) => string;
  geo: Geometry;
}): JSX.Element {
  const cx = geo.width / 2;
  const cy = PAD.top + geo.plotH / 2;

  if (total <= 0) {
    return (
      <text x={cx} y={cy} textAnchor="middle" className="scp-chart-axis-label">
        Nothing recorded in this range.
      </text>
    );
  }

  const outer = Math.min(geo.plotH, geo.width) / 2 - 8;
  // A donut rather than a full pie: the hole carries the total, which is the
  // number people actually want when they reach for this form.
  const inner = outer * 0.58;

  let angle = -Math.PI / 2;
  return (
    <g>
      {items.map((item) => {
        if (item.total <= 0) return null;
        const sweep = (item.total / total) * Math.PI * 2;
        const end = angle + sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const path = [
          `M ${cx + outer * Math.cos(angle)} ${cy + outer * Math.sin(angle)}`,
          `A ${outer} ${outer} 0 ${large} 1 ${cx + outer * Math.cos(end)} ${cy + outer * Math.sin(end)}`,
          `L ${cx + inner * Math.cos(end)} ${cy + inner * Math.sin(end)}`,
          `A ${inner} ${inner} 0 ${large} 0 ${cx + inner * Math.cos(angle)} ${cy + inner * Math.sin(angle)}`,
          'Z',
        ].join(' ');
        angle = end;
        return (
          <path
            key={item.entry.key}
            d={path}
            fill={item.entry.color}
            stroke="var(--color-surface)"
            strokeWidth={GAP}
          />
        );
      })}
      <text x={cx} y={cy + 7} textAnchor="middle" className="scp-chart-centre-value">
        {format(total)}
      </text>
    </g>
  );
}

/* -------------------------------------------------------------------------- */

export interface BarListEntry {
  key: string;
  label: ReactNode;
  value: number;
  detail?: ReactNode;
}

export interface BarListProps {
  entries: readonly BarListEntry[];
  format?: (value: number) => string;
  /** One hue: this is magnitude within a single category, not identity. */
  color?: string;
  empty?: string;
}

export function BarList({
  entries,
  format = defaultFormat,
  color = 'var(--chart-down)',
  empty = 'Nothing recorded.',
}: BarListProps): JSX.Element {
  if (entries.length === 0) return <p className="scp-hint">{empty}</p>;
  const peak = Math.max(1, ...entries.map((entry) => entry.value));

  return (
    <ol className="scp-barlist">
      {entries.map((entry) => (
        <li key={entry.key} className="scp-barlist-row">
          <div className="scp-barlist-head">
            <span className="scp-barlist-label">{entry.label}</span>
            {/* The value wears a text token, never the series colour. */}
            <span className="scp-numeric">{format(entry.value)}</span>
          </div>
          <div className="scp-barlist-track">
            <div
              className="scp-barlist-fill"
              style={{ width: `${Math.max(2, (entry.value / peak) * 100)}%`, background: color }}
            />
          </div>
          {entry.detail ? <div className="scp-hint">{entry.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}
