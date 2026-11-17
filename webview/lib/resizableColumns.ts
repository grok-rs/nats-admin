// Drag-to-resize table columns for every table in every webview.
// A MutationObserver adds a handle to each header cell; dragging switches the
// table to a fixed layout with explicit widths (the scroll container then
// scrolls horizontally instead of squeezing other columns). Double-click a
// handle to reset; widths are remembered per table (by header labels) for the
// webview session. Opt out with <table data-resizable="off">.

const HANDLE = "col-resize-handle";
const MIN_WIDTH = 40;

function keyFor(table: HTMLTableElement): string | undefined {
  const row = table.tHead?.rows[0];
  if (!row) return undefined;
  const labels = Array.from(row.cells, (c) => (c.textContent ?? "").trim()).join("|");
  return labels ? `colw:${labels}` : undefined;
}

function headerCells(table: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(table.tHead?.rows[0]?.cells ?? []);
}

/** Pin every column to its current rendered width so one column can change alone. */
function freeze(table: HTMLTableElement): void {
  if (table.dataset.colsFrozen === "1") return;
  const cells = headerCells(table);
  const widths = cells.map((c) => c.getBoundingClientRect().width);
  cells.forEach((c, i) => (c.style.width = `${Math.round(widths[i])}px`));
  table.style.width = `${Math.round(widths.reduce((a, b) => a + b, 0))}px`;
  table.style.tableLayout = "fixed";
  table.dataset.colsFrozen = "1";
}

function save(table: HTMLTableElement): void {
  const key = keyFor(table);
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(headerCells(table).map((c) => c.style.width)));
  } catch {
    /* storage unavailable */
  }
}

function restore(table: HTMLTableElement): void {
  const key = keyFor(table);
  if (!key || table.dataset.colsFrozen === "1") return;
  let widths: string[] | undefined;
  try {
    widths = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    widths = undefined;
  }
  const cells = headerCells(table);
  if (!widths || widths.length !== cells.length || widths.some((w) => !w)) return;
  cells.forEach((c, i) => (c.style.width = widths![i]));
  table.style.width = `${widths.reduce((a, w) => a + parseFloat(w), 0)}px`;
  table.style.tableLayout = "fixed";
  table.dataset.colsFrozen = "1";
}

function reset(table: HTMLTableElement): void {
  headerCells(table).forEach((c) => (c.style.width = ""));
  table.style.width = "";
  table.style.tableLayout = "";
  delete table.dataset.colsFrozen;
  const key = keyFor(table);
  try {
    if (key) sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function startDrag(e: PointerEvent, th: HTMLTableCellElement, table: HTMLTableElement): void {
  e.preventDefault();
  e.stopPropagation();
  freeze(table);
  const startX = e.clientX;
  const startW = th.getBoundingClientRect().width;
  const startTable = table.getBoundingClientRect().width;
  const handle = e.currentTarget as HTMLElement;
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic / already released pointer */
  }
  document.body.classList.add("col-resizing");
  let moved = false;
  const move = (ev: PointerEvent) => {
    const w = Math.max(MIN_WIDTH, startW + ev.clientX - startX);
    moved = moved || Math.abs(ev.clientX - startX) > 2;
    th.style.width = `${Math.round(w)}px`;
    table.style.width = `${Math.round(startTable + (w - startW))}px`;
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    document.body.classList.remove("col-resizing");
    save(table);
    // Swallow the click that follows a drag so sortable headers don't re-sort.
    if (moved) window.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function enhance(table: HTMLTableElement): void {
  if (table.dataset.resizable === "off") return;
  const cells = headerCells(table);
  if (cells.length < 2) return;
  restore(table);
  cells.forEach((th, i) => {
    if (i === cells.length - 1 || th.querySelector(`:scope > .${HANDLE}`)) return;
    if (getComputedStyle(th).position === "static") th.style.position = "relative";
    const h = document.createElement("span");
    h.className = HANDLE;
    h.setAttribute("role", "separator");
    h.setAttribute("aria-orientation", "vertical");
    h.setAttribute("aria-label", "Resize column (double-click to reset, arrow keys to adjust)");
    h.tabIndex = -1;
    h.addEventListener("pointerdown", (e) => startDrag(e, th, table));
    h.addEventListener("click", (e) => e.stopPropagation());
    h.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      reset(table);
    });
    h.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      freeze(table);
      const step = e.shiftKey ? 40 : 10;
      const w = Math.max(MIN_WIDTH, th.getBoundingClientRect().width + (e.key === "ArrowRight" ? step : -step));
      const delta = w - th.getBoundingClientRect().width;
      th.style.width = `${Math.round(w)}px`;
      table.style.width = `${Math.round(table.getBoundingClientRect().width + delta)}px`;
      save(table);
    });
    th.appendChild(h);
  });
}

let scheduled = false;
function scan(): void {
  scheduled = false;
  document.querySelectorAll<HTMLTableElement>("table").forEach(enhance);
}

export function installResizableColumns(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(scan);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
}
