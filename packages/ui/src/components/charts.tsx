import { useEffect, useId, useState, type ReactNode } from 'react';

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
 * Series colours come from --chart-* tokens, chosen by running the palette
 * validator rather than by eye.
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
  /** Remembers the reader's choice of form across visits. */
  storageKey?: string;
  defaultForm?: ChartForm;
}

/* Geometry. A fixed viewBox scaled uniformly, so strokes keep their weight and
 * circles stay circular - the reason not to stretch the box to the container. */
const VIEW_W = 800;
const VIEW_H = 260;
const PAD = { top: 12, right: 12, bottom: 26, left: 12 };
const PLOT_W = VIEW_W - PAD.left - PAD.right;
const PLOT_H = VIEW_H - PAD.top - PAD.bottom;

/** A surface gap between adjacent fills, so neighbouring segments stay separable. */
const GAP = 2;
const MIN_SEGMENT = 1;
/** Part-to-whole is legible at a glance only up to a handful of segments. */
const MAX_SHARE_SEGMENTS = 6;

const defaultFormat = (value: number): string => value.toLocaleString();

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
  storageKey,
  defaultForm = 'stacked',
}: TimeSeriesChartProps): JSX.Element {
  const [form, setForm] = useState<ChartForm>(defaultForm);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  // Restored after mount rather than during render: reading storage while
  // rendering makes the first paint depend on something React cannot replay.
  useEffect(() => {
    if (!storageKey) return;
    const stored = window.localStorage.getItem(`scp.chart.${storageKey}`);
    if (stored && FORMS.some((entry) => entry.value === stored)) setForm(stored as ChartForm);
  }, [storageKey]);

  const choose = (next: ChartForm): void => {
    setForm(next);
    if (storageKey) window.localStorage.setItem(`scp.chart.${storageKey}`, next);
  };

  if (points.length === 0) {
    return <p className="scp-hint">Nothing was recorded in this range.</p>;
  }

  const totals = points.map((point) => series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0));
  const stackedPeak = Math.max(1, ...totals);
  const singlePeak = Math.max(
    1,
    ...points.flatMap((point) => series.map((entry) => point.values[entry.key] ?? 0)),
  );
  // Stacked forms measure the total; the others measure the tallest series.
  const peak = form === 'stacked' || form === 'area' ? stackedPeak : singlePeak;

  const step = PLOT_W / points.length;
  const y = (value: number): number => PAD.top + PLOT_H - (value / peak) * PLOT_H;
  const centreX = (index: number): number => PAD.left + index * step + step / 2;

  const shareTotals = series.map((entry) => ({
    entry,
    total: points.reduce((sum, point) => sum + (point.values[entry.key] ?? 0), 0),
  }));
  const grandTotal = shareTotals.reduce((sum, item) => sum + item.total, 0);

  return (
    <div className="scp-chart">
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
              title={
                disabled
                  ? `Too many series to read as slices; up to ${MAX_SHARE_SEGMENTS} works.`
                  : entry.hint
              }
              onClick={() => choose(entry.value)}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {/* A share chart is not the same chart drawn differently: the horizontal
          axis is gone. Saying so is cheaper than letting someone read a period
          total as a trend. */}
      {form === 'share' ? (
        <p className="scp-hint">
          The whole selected period as one total. Time is not shown — switch to another form to see when it
          happened.
        </p>
      ) : null}

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-labelledby={titleId}
        className="scp-chart-svg"
      >
        <title id={titleId}>{caption}</title>

        {form === 'share' ? (
          <ShareArcs items={shareTotals} total={grandTotal} format={format} />
        ) : (
          <>
            {/* Recessive reference lines: solid hairlines, one shade off the surface. */}
            {[0.25, 0.5, 0.75, 1].map((fraction) => (
              <line
                key={fraction}
                x1={PAD.left}
                x2={PAD.left + PLOT_W}
                y1={PAD.top + PLOT_H - PLOT_H * fraction}
                y2={PAD.top + PLOT_H - PLOT_H * fraction}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
            ))}

            {form === 'stacked' || form === 'grouped'
              ? points.map((point, index) => (
                  <Bars
                    key={point.at}
                    point={point}
                    series={series}
                    grouped={form === 'grouped'}
                    x={PAD.left + index * step}
                    step={step}
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
                    centreX={centreX}
                    y={y}
                  />
                ))
              : null}

            {/* Hit targets last so they sit above the marks. Each spans the full
                plot height, because a one pixel segment is not pointable. */}
            {points.map((point, index) => (
              <rect
                key={`hit-${point.at}`}
                x={PAD.left + index * step}
                y={PAD.top}
                width={step}
                height={PLOT_H}
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

      {/* Identity is never colour alone: a legend for every multi-series chart. */}
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
  step,
  peak,
}: {
  point: TimePoint;
  series: readonly SeriesDefinition[];
  grouped: boolean;
  x: number;
  step: number;
  peak: number;
}): JSX.Element {
  const slotWidth = step * 0.72;
  const base = PAD.top + PLOT_H;

  if (grouped) {
    const each = Math.max(1, (slotWidth - GAP * (series.length - 1)) / series.length);
    return (
      <g>
        {series.map((entry, index) => {
          const value = point.values[entry.key] ?? 0;
          const height = Math.max(value > 0 ? MIN_SEGMENT : 0, (value / peak) * PLOT_H);
          if (height <= 0) return null;
          return (
            <rect
              key={entry.key}
              x={x + (step - slotWidth) / 2 + index * (each + GAP)}
              y={base - height}
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

  let cursor = base;
  return (
    <g>
      {series.map((entry) => {
        const value = point.values[entry.key] ?? 0;
        if (value <= 0) return null;
        const raw = (value / peak) * PLOT_H;
        const height = Math.max(MIN_SEGMENT, raw - GAP);
        cursor -= height + GAP;
        return (
          <rect
            key={entry.key}
            x={x + (step - slotWidth) / 2}
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
  centreX,
  y,
}: {
  entry: SeriesDefinition;
  seriesIndex: number;
  series: readonly SeriesDefinition[];
  points: readonly TimePoint[];
  area: boolean;
  centreX: (index: number) => number;
  y: (value: number) => number;
}): JSX.Element {
  // In the area form the series stack, so each one starts where the ones below
  // it ended; as lines they each stand on the baseline.
  const valueAt = (index: number): number => {
    const own = points[index]?.values[entry.key] ?? 0;
    if (!area) return own;
    return (
      own +
      series
        .slice(0, seriesIndex)
        .reduce((sum, below) => sum + (points[index]?.values[below.key] ?? 0), 0)
    );
  };
  const baseAt = (index: number): number =>
    area
      ? series
          .slice(0, seriesIndex)
          .reduce((sum, below) => sum + (points[index]?.values[below.key] ?? 0), 0)
      : 0;

  const top = points.map((_, index) => `${centreX(index)},${y(valueAt(index))}`).join(' ');

  return (
    <g>
      {area ? (
        <polygon
          points={`${top} ${points
            .map((_, index) => `${centreX(points.length - 1 - index)},${y(baseAt(points.length - 1 - index))}`)
            .join(' ')}`}
          fill={entry.color}
          opacity={0.85}
          stroke="var(--color-surface)"
          strokeWidth={GAP}
        />
      ) : (
        <polyline points={top} fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" />
      )}
      {/* Markers only when there are few enough that they read as points
          rather than as a thicker line. */}
      {!area && points.length <= 40
        ? points.map((_, index) => (
            <circle
              key={index}
              cx={centreX(index)}
              cy={y(valueAt(index))}
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
}: {
  items: Array<{ entry: SeriesDefinition; total: number }>;
  total: number;
  format: (value: number) => string;
}): JSX.Element {
  if (total <= 0) {
    return (
      <text x={VIEW_W / 2} y={VIEW_H / 2} textAnchor="middle" fill="var(--color-text-secondary)" fontSize={14}>
        Nothing recorded in this range.
      </text>
    );
  }

  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2;
  const outer = Math.min(PLOT_H, VIEW_W) / 2 - 6;
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
      <text
        x={cx}
        y={cy + 6}
        textAnchor="middle"
        fill="var(--color-text-primary)"
        fontSize={20}
        fontWeight={600}
      >
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
