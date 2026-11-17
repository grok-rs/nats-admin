// DOM helpers for charts: text measurement and resolving theme colours to RGB
// (to pick white or near-black ink for labels printed inside a coloured fill).

let canvasCtx: CanvasRenderingContext2D | null | undefined;
let fontFamily: string | undefined;

function ctx2d(): CanvasRenderingContext2D | null {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    } catch {
      canvasCtx = null;
    }
  }
  return canvasCtx;
}

/** Rendered width (px) of `text` in the UI font (or the editor font with mono=true). */
export function measureText(text: string, fontPx = 11, mono = false): number {
  const c = ctx2d();
  if (!c) return text.length * fontPx * (mono ? 0.62 : 0.56);
  if (fontFamily === undefined) fontFamily = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  const family = mono ? getComputedStyle(document.body).getPropertyValue("--vscode-editor-font-family").trim() || "monospace" : fontFamily;
  c.font = `${fontPx}px ${family}`;
  return c.measureText(text).width;
}

/** Max rendered width among `texts`. */
export function maxTextWidth(texts: readonly string[], fontPx = 11, mono = false): number {
  let w = 0;
  for (const t of texts) w = Math.max(w, measureText(t, fontPx, mono));
  return Math.ceil(w);
}

/** Shorten `text` with "…" until it fits `maxPx`. */
export function fitText(text: string, maxPx: number, fontPx = 11, mono = false): string {
  if (maxPx <= 0) return "";
  if (measureText(text, fontPx, mono) <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureText(`${text.slice(0, mid)}…`, fontPx, mono) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : "";
}

let probe: HTMLSpanElement | undefined;
const rgbCache = new Map<string, [number, number, number] | null>();

/**
 * Resolve any CSS colour (including var(), color-mix(), relative oklch) to sRGB 0–255 via the
 * browser: a hidden probe computes the colour, a 1×1 canvas converts it to pixels.
 * `themeKey` invalidates the cache when the theme changes (see useThemeVersion).
 */
export function resolveRgb(css: string, themeKey: number | string = 0): [number, number, number] | null {
  const key = `${themeKey}|${css}`;
  if (rgbCache.has(key)) return rgbCache.get(key)!;
  if (rgbCache.size > 500) rgbCache.clear();
  let out: [number, number, number] | null = null;
  try {
    if (!probe) {
      probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
      document.body.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = css;
    const computed = getComputedStyle(probe).color;
    const c = ctx2d();
    if (c && computed) {
      c.clearRect(0, 0, 1, 1);
      c.fillStyle = "#000";
      c.fillStyle = computed;
      c.fillRect(0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2]];
    }
  } catch {
    out = null;
  }
  rgbCache.set(key, out);
  return out;
}

/** APCA lightness contrast (Lc, signed) of text on background, both sRGB 0–255. */
export function apcaContrast(text: readonly number[], bg: readonly number[]): number {
  const y = (c: readonly number[]) => {
    const v = 0.2126729 * (c[0] / 255) ** 2.4 + 0.7151522 * (c[1] / 255) ** 2.4 + 0.072175 * (c[2] / 255) ** 2.4;
    return v < 0.022 ? v + (0.022 - v) ** 1.414 : v;
  };
  const yt = y(text);
  const yb = y(bg);
  if (yb > yt) {
    const s = (yb ** 0.56 - yt ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (yb ** 0.65 - yt ** 0.62) * 1.14;
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

const WHITE = [255, 255, 255];
const NEAR_BLACK = [11, 11, 11];

/** "#ffffff" or "#0b0b0b", whichever reads better (APCA) on the given fill colour. */
export function inkOn(css: string, themeKey: number | string = 0): string {
  const rgb = resolveRgb(css, themeKey);
  if (!rgb) return "#ffffff";
  return Math.abs(apcaContrast(NEAR_BLACK, rgb)) > Math.abs(apcaContrast(WHITE, rgb)) ? "#0b0b0b" : "#ffffff";
}
