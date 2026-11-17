// Layered (Sugiyama-style) left-to-right graph layout. Pure and deterministic: the same input
// always yields the same coordinates, so the topology graph does not jump between refreshes.
//
//   1. connected components, sorted by a caller-provided group key
//   2. cycle breaking (DFS back edges are reversed for layering only)
//   3. longest-path layering, then sources are pulled right next to their targets
//   4. dummy nodes for edges spanning several layers
//   5. crossing minimisation: alternating barycenter sweeps, best ordering kept
//      (crossings counted exactly with a Fenwick tree)
//   6. y coordinates: per-layer isotonic regression (PAVA) towards neighbour barycenters, which
//      respects the order and the minimum gap exactly; dummies weigh more (straight long edges)
//   7. global columns (same x for the same layer across components); components are packed into
//      shelves (each as wide as its widest component), choosing the shelf count that fits a
//      viewport of the requested aspect at the largest scale
//   8. edge polylines through dummy points with ports spread along the node side
//
// No vscode / DOM imports: used by webview/topology.tsx and unit tested in test/admin.test.ts.

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
  /** Deterministic tie-break key (e.g. "2:ORDERS"). */
  order: string;
  /** Components are sorted by the smallest group key of their nodes (default: order). */
  groupKey?: string;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
}

export interface LayoutOptions {
  /** Horizontal gap between layers (default 72). */
  layerGap?: number;
  /** Vertical gap between nodes in a layer (default 10). */
  nodeGap?: number;
  /** Vertical gap between components on a shelf (default 28). */
  componentGap?: number;
  /** Horizontal gap between shelves (default 96). */
  shelfGap?: number;
  /** Width / height ratio of the viewport the graph should fit (default 1.8; 0 = never wrap into shelves). */
  aspect?: number;
  /** Max crossing-minimisation sweeps (default 16; fewer for big graphs). */
  iterations?: number;
}

export interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  component: number;
}

export interface PositionedEdge {
  id: string;
  from: string;
  to: string;
  points: [number, number][];
  /** True when the edge points against the layer direction (part of a cycle). */
  reversed: boolean;
}

export interface Layout {
  nodes: Map<string, PositionedNode>;
  edges: PositionedEdge[];
  width: number;
  height: number;
  /** Total edge crossings between adjacent layers after minimisation. */
  crossings: number;
  /** Order of node ids per (component, layer): useful for keyboard navigation. */
  columns: string[][][];
}

interface Item {
  id: string;
  dummy: boolean;
  width: number;
  height: number;
  order: string;
  layer: number;
}

const DUMMY_H = 4;

export function layoutGraph(nodesIn: readonly LayoutNodeInput[], edgesIn: readonly LayoutEdgeInput[], opts: LayoutOptions = {}): Layout {
  const layerGap = opts.layerGap ?? 72;
  const nodeGap = opts.nodeGap ?? 10;
  const componentGap = opts.componentGap ?? 28;
  const shelfGap = opts.shelfGap ?? 96;
  const aspect = opts.aspect ?? 1.8;
  const maxIter = opts.iterations ?? (nodesIn.length > 600 ? 4 : nodesIn.length > 200 ? 8 : 16);

  const nodeById = new Map<string, LayoutNodeInput>();
  for (const n of nodesIn) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const nodes = [...nodeById.values()].sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));
  const edges = edgesIn.filter((e) => e.from !== e.to && nodeById.has(e.from) && nodeById.has(e.to));

  // ---- 1. components ------------------------------------------------------------------------
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const e of edges) {
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(cmp(a, b) < 0 ? b : a, cmp(a, b) < 0 ? a : b);
  }
  const compMap = new Map<string, LayoutNodeInput[]>();
  for (const n of nodes) {
    const r = find(n.id);
    (compMap.get(r) ?? compMap.set(r, []).get(r)!).push(n);
  }
  const comps = [...compMap.values()]
    .map((members) => ({ members, key: members.reduce((m, n) => (cmp(n.groupKey ?? n.order, m) < 0 ? (n.groupKey ?? n.order) : m), "￿") }))
    .sort((a, b) => cmp(a.key, b.key));

  const edgesByComp = new Map<string, LayoutEdgeInput[]>();
  for (const e of edges) {
    const r = find(e.from);
    (edgesByComp.get(r) ?? edgesByComp.set(r, []).get(r)!).push(e);
  }

  // ---- per component: layering, ordering, y ------------------------------------------------
  interface CompLayout {
    layers: Item[][];
    items: Map<string, Item>;
    y: Map<string, number>;
    height: number;
    maxLayer: number;
    chains: Map<string, { ids: string[]; reversed: boolean }>;
    crossings: number;
  }
  const compLayouts: CompLayout[] = [];
  const colWidth: number[] = [];

  for (const comp of comps) {
    const members = comp.members;
    const cEdges = edgesByComp.get(find(members[0].id)) ?? [];
    const orderOf = new Map(members.map((n) => [n.id, n.order]));

    // 2. cycle breaking: DFS in deterministic order; edges to nodes on the stack are reversed.
    const out = new Map<string, LayoutEdgeInput[]>();
    for (const e of cEdges) (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    for (const list of out.values()) list.sort((a, b) => cmp(orderOf.get(a.to)!, orderOf.get(b.to)!) || cmp(a.id, b.id));
    const state = new Map<string, 1 | 2>();
    const reversedEdge = new Set<string>();
    for (const n of members) {
      if (state.has(n.id)) continue;
      const stack: { id: string; i: number }[] = [{ id: n.id, i: 0 }];
      state.set(n.id, 1);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const list = out.get(top.id) ?? [];
        if (top.i >= list.length) {
          state.set(top.id, 2);
          stack.pop();
          continue;
        }
        const e = list[top.i++];
        const st = state.get(e.to);
        if (st === 1) reversedEdge.add(e.id);
        else if (st === undefined) {
          state.set(e.to, 1);
          stack.push({ id: e.to, i: 0 });
        }
      }
    }
    const dag = cEdges.map((e) => (reversedEdge.has(e.id) ? { id: e.id, from: e.to, to: e.from, reversed: true } : { id: e.id, from: e.from, to: e.to, reversed: false }));

    // 3. longest-path layering (Kahn, deterministic), then pull sources right.
    const succ = new Map<string, string[]>();
    const pred = new Map<string, string[]>();
    const indeg = new Map<string, number>(members.map((n) => [n.id, 0]));
    for (const e of dag) {
      (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to);
      (pred.get(e.to) ?? pred.set(e.to, []).get(e.to)!).push(e.from);
      indeg.set(e.to, indeg.get(e.to)! + 1);
    }
    const layer = new Map<string, number>(members.map((n) => [n.id, 0]));
    const queue = members.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const topo: string[] = [];
    while (queue.length) {
      const v = queue.shift()!;
      topo.push(v);
      for (const w of succ.get(v) ?? []) {
        layer.set(w, Math.max(layer.get(w)!, layer.get(v)! + 1));
        indeg.set(w, indeg.get(w)! - 1);
        if (indeg.get(w) === 0) queue.push(w);
      }
    }
    for (let i = topo.length - 1; i >= 0; i--) {
      const v = topo[i];
      if ((pred.get(v)?.length ?? 0) === 0 && (succ.get(v)?.length ?? 0) > 0) {
        layer.set(v, Math.min(...succ.get(v)!.map((w) => layer.get(w)!)) - 1);
      }
    }
    const minL = Math.min(...members.map((n) => layer.get(n.id)!));
    for (const n of members) layer.set(n.id, layer.get(n.id)! - minL);

    // 4. items + dummy chains
    const items = new Map<string, Item>();
    for (const n of members) items.set(n.id, { id: n.id, dummy: false, width: n.width, height: n.height, order: n.order, layer: layer.get(n.id)! });
    const chains = new Map<string, { ids: string[]; reversed: boolean }>();
    const adjDown = new Map<string, string[]>();
    const adjUp = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      (adjDown.get(a) ?? adjDown.set(a, []).get(a)!).push(b);
      (adjUp.get(b) ?? adjUp.set(b, []).get(b)!).push(a);
    };
    for (const e of dag) {
      const la = layer.get(e.from)!;
      const lb = layer.get(e.to)!;
      const ids = [e.from];
      let prev = e.from;
      for (let l = la + 1; l < lb; l++) {
        const did = `\u0000d:${e.id}:${l}`;
        items.set(did, { id: did, dummy: true, width: 0, height: DUMMY_H, order: `${items.get(e.from)!.order}\u0000${e.id}`, layer: l });
        link(prev, did);
        ids.push(did);
        prev = did;
      }
      link(prev, e.to);
      ids.push(e.to);
      chains.set(e.id, { ids, reversed: e.reversed });
    }
    const maxLayer = Math.max(0, ...[...items.values()].map((it) => it.layer));
    const layers: Item[][] = Array.from({ length: maxLayer + 1 }, () => []);
    for (const it of items.values()) layers[it.layer].push(it);
    for (const l of layers) l.sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));

    // 5. crossing minimisation
    const pos = new Map<string, number>();
    const index = () => layers.forEach((l) => l.forEach((it, i) => pos.set(it.id, i)));
    index();
    const sweep = (down: boolean) => {
      const range = down ? rangeOf(1, maxLayer) : rangeOf(maxLayer - 1, 0);
      for (const l of range) {
        const adj = down ? adjUp : adjDown;
        const scored = layers[l].map((it, i) => {
          const nb = adj.get(it.id);
          const bary = nb && nb.length ? nb.reduce((s, x) => s + pos.get(x)!, 0) / nb.length : i;
          return { it, bary, i };
        });
        scored.sort((a, b) => a.bary - b.bary || a.i - b.i);
        layers[l] = scored.map((s) => s.it);
        layers[l].forEach((it, i) => pos.set(it.id, i));
      }
    };
    const countAll = () => {
      let total = 0;
      for (let l = 0; l < maxLayer; l++) total += countCrossings(layers[l], layers[l + 1], adjDown, pos);
      return total;
    };
    let best = countAll();
    let bestLayers = layers.map((l) => [...l]);
    for (let it = 0; it < maxIter && best > 0; it++) {
      sweep(it % 2 === 0);
      const c = countAll();
      if (c < best) {
        best = c;
        bestLayers = layers.map((l) => [...l]);
      }
    }
    for (let l = 0; l <= maxLayer; l++) layers[l] = bestLayers[l];
    index();

    // 6. y coordinates
    const y = new Map<string, number>();
    const tallest = Math.max(...layers.map((l) => stackHeight(l, nodeGap)));
    for (const l of layers) {
      let cur = (tallest - stackHeight(l, nodeGap)) / 2;
      for (const it of l) {
        y.set(it.id, cur);
        cur += it.height + nodeGap;
      }
    }
    const center = (id: string) => y.get(id)! + items.get(id)!.height / 2;
    const place = (l: Item[], adj: Map<string, string[]>) => {
      const desired = l.map((it) => {
        const nb = adj.get(it.id);
        const c = nb && nb.length ? nb.reduce((s, x) => s + center(x), 0) / nb.length : center(it.id);
        return c - it.height / 2;
      });
      const tops = isotonicPlace(
        l.map((it) => it.height),
        desired,
        l.map((it) => (it.dummy ? 2 : 1)),
        nodeGap,
      );
      l.forEach((it, i) => y.set(it.id, tops[i]));
    };
    const rounds = members.length > 600 ? 2 : 6;
    for (let r = 0; r < rounds; r++) {
      for (let l = 1; l <= maxLayer; l++) place(layers[l], adjUp);
      for (let l = maxLayer - 1; l >= 0; l--) place(layers[l], adjDown);
    }
    let minY = Infinity;
    let maxY = -Infinity;
    for (const it of items.values()) {
      minY = Math.min(minY, y.get(it.id)!);
      maxY = Math.max(maxY, y.get(it.id)! + it.height);
    }
    for (const it of items.values()) y.set(it.id, Math.round((y.get(it.id)! - minY) * 10) / 10);
    for (const l of layers) {
      const w = Math.max(0, ...l.map((it) => it.width));
      const idx = l[0]?.layer ?? 0;
      colWidth[idx] = Math.max(colWidth[idx] ?? 0, w);
    }
    compLayouts.push({ layers, items, y, height: maxY - minY, maxLayer, chains, crossings: best });
  }

  // ---- 7. columns and shelves ----------------------------------------------------------------
  for (let i = 0; i < colWidth.length; i++) colWidth[i] = colWidth[i] ?? 0;
  const colX: number[] = [];
  let acc = 0;
  for (let i = 0; i < colWidth.length; i++) {
    colX[i] = acc;
    acc += colWidth[i] + layerGap;
  }
  const compWidth = (c: CompLayout) => colX[c.maxLayer] + colWidth[c.maxLayer];
  const sumH = compLayouts.reduce((s, c) => s + c.height, 0) + componentGap * Math.max(0, compLayouts.length - 1);
  const maxH = compLayouts.length ? Math.max(...compLayouts.map((c) => c.height)) : 0;

  /** Components in order, wrapped into a new shelf above `target` height; each shelf is as wide as its widest component. */
  const pack = (target: number) => {
    const offs: { dx: number; dy: number }[] = [];
    const shelfOf: number[] = [];
    const shelfW: number[] = [];
    let shelf = 0;
    let shelfY = 0;
    let h = 0;
    for (const c of compLayouts) {
      if (shelfY > 0 && shelfY + c.height > target) {
        shelf++;
        shelfY = 0;
      }
      shelfOf.push(shelf);
      offs.push({ dx: 0, dy: shelfY });
      shelfW[shelf] = Math.max(shelfW[shelf] ?? 0, compWidth(c));
      h = Math.max(h, shelfY + c.height);
      shelfY += c.height + componentGap;
    }
    const shelfX: number[] = [];
    let x = 0;
    for (let s = 0; s < shelfW.length; s++) {
      shelfX.push(x);
      x += shelfW[s] + shelfGap;
    }
    offs.forEach((o, i) => (o.dx = shelfX[shelfOf[i]]));
    return { offs, width: Math.max(0, x - shelfGap), height: h };
  };
  // Pick the shelf count whose bounding box fits a viewport of the requested aspect at the largest
  // scale (fewer shelves win ties). aspect 0 never wraps.
  let packed = pack(Infinity);
  if (aspect > 0 && compLayouts.length > 1 && packed.width > 0) {
    let bestScore = Math.min(aspect / packed.width, 1 / Math.max(1, packed.height));
    for (let s = 2; s <= Math.min(compLayouts.length, 16); s++) {
      const cand = pack(Math.max(maxH, (sumH / s) * 1.04));
      const score = Math.min(aspect / cand.width, 1 / Math.max(1, cand.height));
      if (score > bestScore * 1.0001) {
        bestScore = score;
        packed = cand;
      }
    }
  }

  const positioned = new Map<string, PositionedNode>();
  const columns: string[][][] = [];
  const offsets = packed.offs;
  let width = 0;
  let height = 0;
  compLayouts.forEach((c, ci) => {
    const { dx, dy } = offsets[ci];
    width = Math.max(width, dx + compWidth(c));
    height = Math.max(height, dy + c.height);
    columns.push(c.layers.map((l) => l.filter((it) => !it.dummy).map((it) => it.id)));
    for (const l of c.layers)
      for (const it of l) {
        if (it.dummy) continue;
        positioned.set(it.id, {
          id: it.id,
          x: dx + colX[it.layer] + (colWidth[it.layer] - it.width) / 2,
          y: dy + c.y.get(it.id)!,
          width: it.width,
          height: it.height,
          layer: it.layer,
          component: ci,
        });
      }
  });

  // ---- 8. edges ---------------------------------------------------------------------------
  const pointOf = (ci: number, id: string, side: "in" | "out"): [number, number] => {
    const p = positioned.get(id);
    if (p) return [side === "out" ? p.x + p.width : p.x, p.y + p.height / 2];
    const c = compLayouts[ci];
    const it = c.items.get(id)!;
    const o = offsets[ci];
    return [o.dx + colX[it.layer] + colWidth[it.layer] / 2, o.dy + c.y.get(id)! + DUMMY_H / 2];
  };
  const routed: PositionedEdge[] = [];
  const outPorts = new Map<string, { edge: PositionedEdge; next: number }[]>();
  const inPorts = new Map<string, { edge: PositionedEdge; prev: number }[]>();
  for (const e of edges) {
    const ci = positioned.get(e.from)!.component;
    const chain = compLayouts[ci].chains.get(e.id);
    if (!chain) continue;
    const pts = chain.ids.map((id, i) => pointOf(ci, id, i === 0 ? "out" : i === chain.ids.length - 1 ? "in" : "out"));
    const edge: PositionedEdge = { id: e.id, from: e.from, to: e.to, points: chain.reversed ? pts.reverse() : pts, reversed: chain.reversed };
    routed.push(edge);
    // ports in DAG direction: first id leaves on the right, last id enters on the left
    const first = chain.ids[0];
    const last = chain.ids[chain.ids.length - 1];
    const dagPts = chain.reversed ? [...edge.points].reverse() : edge.points;
    (outPorts.get(first) ?? outPorts.set(first, []).get(first)!).push({ edge, next: dagPts[1][1] });
    (inPorts.get(last) ?? inPorts.set(last, []).get(last)!).push({ edge, prev: dagPts[dagPts.length - 2][1] });
  }
  const spread = (id: string, list: { edge: PositionedEdge; key: number }[], atStart: boolean) => {
    const p = positioned.get(id);
    if (!p || list.length < 2) return;
    list.sort((a, b) => a.key - b.key || cmp(a.edge.id, b.edge.id));
    const step = Math.min(6, (p.height - 8) / (list.length - 1));
    list.forEach(({ edge }, i) => {
      const off = (i - (list.length - 1) / 2) * step;
      const dagFirst = !edge.reversed;
      // atStart: the DAG-first point of the edge sits on this node
      const idx = atStart === dagFirst ? 0 : edge.points.length - 1;
      edge.points[idx] = [edge.points[idx][0], p.y + p.height / 2 + off];
    });
  };
  for (const [id, list] of outPorts) spread(id, list.map((x) => ({ edge: x.edge, key: x.next })), true);
  for (const [id, list] of inPorts) spread(id, list.map((x) => ({ edge: x.edge, key: x.prev })), false);
  for (const e of routed) e.points = e.points.map(([x, yy]) => [Math.round(x * 10) / 10, Math.round(yy * 10) / 10]);

  return { nodes: positioned, edges: routed, width: Math.ceil(width), height: Math.ceil(height), crossings: compLayouts.reduce((s, c) => s + c.crossings, 0), columns };
}

/** SVG path through the polyline with horizontal tangents at every point (smooth S-curves). */
export function edgePath(points: readonly [number, number][]): string {
  if (!points.length) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const dx = (x1 - x0) / 2;
    d += ` C${round1(x0 + dx)},${y0} ${round1(x1 - dx)},${y1} ${x1},${y1}`;
  }
  return d;
}

/** Midpoint of the polyline's middle segment (edge label anchor). */
export function edgeMidpoint(points: readonly [number, number][]): [number, number] {
  if (points.length < 2) return points[0] ?? [0, 0];
  const i = Math.floor((points.length - 1) / 2);
  const [x0, y0] = points[i];
  const [x1, y1] = points[i + 1];
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

// ---- helpers ---------------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function rangeOf(from: number, to: number): number[] {
  const out: number[] = [];
  if (from <= to) for (let i = from; i <= to; i++) out.push(i);
  else for (let i = from; i >= to; i--) out.push(i);
  return out;
}

function stackHeight(l: { height: number }[], gap: number): number {
  return l.reduce((s, it) => s + it.height, 0) + gap * Math.max(0, l.length - 1);
}

/** Exact count of crossings between two adjacent layers (Fenwick tree inversion count). */
export function countCrossings(upper: { id: string }[], lower: { id: string }[], down: Map<string, string[]>, pos: Map<string, number>): number {
  const lowerSet = new Set(lower.map((x) => x.id));
  const pairs: [number, number][] = [];
  for (const u of upper) for (const v of down.get(u.id) ?? []) if (lowerSet.has(v)) pairs.push([pos.get(u.id)!, pos.get(v)!]);
  if (pairs.length < 2) return 0;
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = lower.length;
  const tree = new Array<number>(n + 1).fill(0);
  let crossings = 0;
  let seen = 0;
  for (const [, v] of pairs) {
    // count earlier pairs whose lower position is greater than v
    let le = 0;
    for (let i = v + 1; i > 0; i -= i & -i) le += tree[i];
    crossings += seen - le;
    for (let i = v + 1; i <= n; i += i & -i) tree[i]++;
    seen++;
  }
  return crossings;
}

/**
 * Place items (in fixed order) as close as possible to their desired tops while keeping
 * `top[i+1] ≥ top[i] + h[i] + gap`: weighted isotonic regression (pool adjacent violators).
 */
export function isotonicPlace(heights: readonly number[], desired: readonly number[], weights: readonly number[], gap: number): number[] {
  const n = heights.length;
  const offset: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    offset.push(s);
    s += heights[i] + gap;
  }
  // z_i = top_i - offset_i must be non-decreasing
  const blocks: { value: number; weight: number; count: number }[] = [];
  for (let i = 0; i < n; i++) {
    blocks.push({ value: desired[i] - offset[i], weight: weights[i], count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      const w = a.weight + b.weight;
      blocks.push({ value: (a.value * a.weight + b.value * b.weight) / w, weight: w, count: a.count + b.count });
    }
  }
  const out: number[] = [];
  let i = 0;
  for (const b of blocks) for (let k = 0; k < b.count; k++, i++) out.push(b.value + offset[i]);
  return out;
}
