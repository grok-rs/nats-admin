// Compact multi-series rate card (legacy API, used by the server dashboard).
// New code should use the chart library instead:
//   TimeSeriesChart for time series with axes, Sparkline (re-exported here as SparklineChart)
//   for word-sized trends — both from "./charts".

export { Sparkline as SparklineChart } from "./charts/Sparkline";
export type { SparklineProps as SparklineChartProps } from "./charts/Sparkline";

export function Sparkline({
  series,
  height = 56,
  label,
  format = (v: number) => v.toFixed(0),
}: {
  series: { values: number[]; color: string; name: string }[];
  height?: number;
  label?: string;
  format?: (v: number) => string;
}) {
  const width = 300;
  const n = Math.max(2, ...series.map((s) => s.values.length));
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number, len: number) => ((i + (n - len)) / (n - 1)) * width;
  const y = (v: number) => height - 4 - (v / max) * (height - 8);
  const summary = series.map((s) => `${s.name} ${format(s.values.at(-1) ?? 0)}`).join(", ");
  return (
    <div class="spark">
      <div class="spark-head">
        {label && <span class="spark-label">{label}</span>}
        <span class="spark-legend">
          {series.map((s) => (
            <span key={s.name} class="spark-legend-item">
              <span class="spark-swatch" style={{ background: s.color }} />
              {s.name} <b>{format(s.values.at(-1) ?? 0)}</b>
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" class="spark-svg" role="img" aria-label={`${label ?? "Trend"}: ${summary}; max ${format(max)}`}>
        <line x1="0" x2={width} y1={height - 4} y2={height - 4} class="spark-axis" />
        {series.map((s) => {
          if (s.values.length < 2) return null;
          const pts = s.values.map((v, i) => `${x(i, s.values.length).toFixed(1)},${y(v).toFixed(1)}`);
          const area = `M${x(0, s.values.length).toFixed(1)},${height - 4} L${pts.join(" L")} L${x(s.values.length - 1, s.values.length).toFixed(1)},${height - 4} Z`;
          return (
            <g key={s.name}>
              <path d={area} fill={s.color} opacity="0.12" />
              <polyline points={pts.join(" ")} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      <div class="spark-scale">max {format(max)}</div>
    </div>
  );
}
