import { useId, useState, type ReactNode } from 'react';

/**
 * The two chart forms this product needs, drawn as inline SVG.
 *
 * No charting dependency: these are bars and rectangles, and a library would
 * add a supply chain and a second design language for the sake of geometry we
 * can write down. The rules they follow come from docs/design/statistics.md:
 * thin marks, a 2px surface gap between stacked segments so adjacent fills stay
 * separable, recessive grid lines, a legend whenever more than one series is
 * present, a hover layer, and a table underneath for anyone the colours do not
 * reach.
 *
 * Series colours come from --chart-* tokens, which were chosen by running the
 * palette validator rather than by eye - two of the status foregrounds sit only
 * 9 dE apart and are unusable as neighbouring segments.
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

export interface StackedTimeChartProps {
  points: readonly TimePoint[];
  series: readonly SeriesDefinition[];
  /** Formats a value for the tooltip and the table. */
  format?: (value: number) => string;
  height?: number;
  /** Names what is being counted; read out to screen readers. */
  caption: string;
}

const SEGMENT_GAP = 2;
const MIN_SEGMENT = 1;

const defaultFormat = (value: number): string => value.toLocaleString();

function shortTime(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? at
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function StackedTimeChart({
  points,
  series,
  format = defaultFormat,
  height = 220,
  caption,
}: StackedTimeChartProps): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  if (points.length === 0) {
    return <p className="scp-hint">Nothing was recorded in this range.</p>;
  }

  const totals = points.map((point) => series.reduce((sum, entry) => sum + (point.values[entry.key] ?? 0), 0));
  const peak = Math.max(1, ...totals);

  const width = 100;
  const plot = height - 24;
  const step = width / points.length;
  const barWidth = Math.max(0.6, step * 0.72);

  return (
    <div className="scp-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={titleId}
        className="scp-chart-svg"
        style={{ height }}
      >
        <title id={titleId}>{caption}</title>

        {/* Recessive reference lines. Four is enough to read a magnitude. */}
        {[0.25, 0.5, 0.75, 1].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={width}
            y1={plot - plot * fraction}
            y2={plot - plot * fraction}
            stroke="var(--chart-grid)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {points.map((point, index) => {
          const x = index * step + (step - barWidth) / 2;
          let cursor = plot;
          return (
            <g
              key={point.at}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              role="presentation"
            >
              {/* A hit target the full height of the plot: a one pixel bar is
                  not something anyone can point at. */}
              <rect
                x={index * step}
                y={0}
                width={step}
                height={plot}
                fill={hover === index ? 'var(--color-surface-hover)' : 'transparent'}
              />
              {series.map((entry) => {
                const value = point.values[entry.key] ?? 0;
                if (value <= 0) return null;
                const raw = (value / peak) * plot;
                const segment = Math.max(MIN_SEGMENT, raw - SEGMENT_GAP);
                cursor -= segment + SEGMENT_GAP;
                return (
                  <rect
                    key={entry.key}
                    x={x}
                    y={cursor}
                    width={barWidth}
                    height={segment}
                    fill={entry.color}
                    rx={0.8}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {hover !== null && points[hover] ? (
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
