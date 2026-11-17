// Table views: the accessible twin of a chart (every value readable without hovering).
// Use as Card `tableView` content.

import { colorOf } from "./palette";
import { fmtTimeFull } from "./scale";
import { nearestIndex } from "./series";
import type { TimeSeries } from "./TimeSeriesChart";
import { formatValue, type Unit } from "./units";
import { Swatch } from "./Legend";
import "./charts.css";

/** Time × series table, newest first (at most `limit` rows, default 30). */
export function SeriesTable({ series, unit, limit = 30, caption }: { series: readonly TimeSeries[]; unit?: Unit; limit?: number; caption?: string }) {
  const ref = series.reduce<TimeSeries | undefined>((b, s) => (!b || s.points.length > b.points.length ? s : b), undefined);
  const times = ref ? ref.points.slice(-limit).map((p) => p.t).reverse() : [];
  return (
    <div class="vz-table-wrap">
      <table class="table vz-table">
        {caption && <caption class="sr-only">{caption}</caption>}
        <thead>
          <tr>
            <th scope="col">Time</th>
            {series.map((s, i) => (
              <th scope="col" class="num" key={s.id}>
                <span class="vz-th-key">
                  <Swatch color={colorOf(s, i)} shape="line" />
                  {s.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((t) => (
            <tr key={t}>
              <td class="mono">{fmtTimeFull(t)}</td>
              {series.map((s) => {
                const i = nearestIndex(s.points, t);
                const p = i >= 0 ? s.points[i] : undefined;
                return (
                  <td class="num" key={s.id}>
                    {p && p.t === t ? formatValue(p.v, unit) : "–"}
                  </td>
                );
              })}
            </tr>
          ))}
          {!times.length && (
            <tr>
              <td colSpan={series.length + 1} class="muted">
                No data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Label × value table (with share of total) for bar lists, donuts, segment bars. */
export function ItemsTable({ items, unit, labelHeader = "Name", valueHeader = "Value", mono, caption }: { items: readonly { label: string; value: number; color?: string }[]; unit?: Unit; labelHeader?: string; valueHeader?: string; mono?: boolean; caption?: string }) {
  const total = items.reduce((a, i) => a + Math.max(0, i.value), 0);
  return (
    <div class="vz-table-wrap">
      <table class="table vz-table">
        {caption && <caption class="sr-only">{caption}</caption>}
        <thead>
          <tr>
            <th scope="col">{labelHeader}</th>
            <th scope="col" class="num">
              {valueHeader}
            </th>
            <th scope="col" class="num">
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={`${it.label}#${i}`}>
              <td class={mono ? "mono" : undefined}>
                {it.color && <Swatch color={it.color} />} {it.label}
              </td>
              <td class="num">{formatValue(it.value, unit)}</td>
              <td class="num">{total > 0 ? `${((Math.max(0, it.value) / total) * 100).toFixed(1)}%` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
