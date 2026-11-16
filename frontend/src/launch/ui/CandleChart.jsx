// Candlestick chart for a launch token: SVG drawn from /launch/candles, with volume bars, a price axis on the
// right, time labels and a crosshair that reads out the candle under the pointer. Colours are tokens
// (green up, red down), so it follows both themes.
import { useMemo, useRef, useState, useEffect } from 'react';
import { smallNumber, compact } from '../format.js';

const H = 320;
const VOL_H = 56;
const AXIS_W = 72;
const AXIS_H = 22;
const PAD_TOP = 12;

const pad2 = (n) => String(n).padStart(2, '0');
function timeLabel(t, interval) {
  const d = new Date(t * 1000);
  if (interval === '1d') return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  if (interval === '4h' || interval === '1h') return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${pad2(d.getUTCHours())}h`;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Nice round ticks between lo and hi (about `n` of them). */
function ticks(lo, hi, n = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

export function CandleChart({ candles = [], interval, scale = 1, unit = '', loading }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    const plotW = width - AXIS_W;
    // Show as many candles as fit at ~6 px each, newest on the right.
    const fit = Math.max(20, Math.floor(plotW / 6));
    const list = candles.slice(-fit).map((c) => ({ ...c, o: c.o * scale, h: c.h * scale, l: c.l * scale, c: c.c * scale }));
    if (!list.length) return null;
    let lo = Math.min(...list.map((c) => c.l));
    let hi = Math.max(...list.map((c) => c.h));
    if (hi === lo) {
      hi *= 1.02;
      lo *= 0.98;
    }
    const span = hi - lo;
    hi += span * 0.08;
    lo = Math.max(0, lo - span * 0.08);
    const priceH = H - VOL_H - AXIS_H - PAD_TOP;
    const y = (v) => PAD_TOP + ((hi - v) / (hi - lo)) * priceH;
    const slot = plotW / fit;
    const offset = (fit - list.length) * slot;
    const x = (i) => offset + i * slot + slot / 2;
    const maxV = Math.max(...list.map((c) => c.v || 0), 1e-18);
    const body = Math.max(1, Math.min(9, slot * 0.66));
    const labelEvery = Math.max(1, Math.round(90 / slot));
    return { list, y, x, slot, body, maxV, lo, hi, plotW, labelEvery, offset };
  }, [candles, width, scale]);

  const onMove = (e) => {
    if (!view) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round((px - view.offset - view.slot / 2) / view.slot);
    setHover(i >= 0 && i < view.list.length ? i : null);
  };

  const hc = view && hover != null ? view.list[hover] : view?.list[view.list.length - 1];
  const fmt = (v) => `${unit === '$' ? '$' : ''}${smallNumber(v)}${unit && unit !== '$' ? ` ${unit}` : ''}`;

  return (
    <div className="pl-launch-chart" ref={wrap}>
      {hc && (
        <div className="pl-launch-chart-readout mono" aria-live="off">
          <span>O {fmt(hc.o)}</span>
          <span>H {fmt(hc.h)}</span>
          <span>L {fmt(hc.l)}</span>
          <span className={hc.c >= hc.o ? 'pl-launch-buy' : 'pl-launch-sell'}>C {fmt(hc.c)}</span>
          <span className="pl-launch-muted">Vol {compact(hc.v)}{unit && unit !== '$' ? ` ${unit}` : ''}</span>
        </div>
      )}
      {!view ? (
        <div className="pl-launch-chart-empty" style={{ height: H }}>
          {loading ? 'Loading chart...' : 'No trades yet. The chart starts with the first trade.'}
        </div>
      ) : (
        <svg width={width} height={H} role="img" aria-label="Price chart" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks(view.lo, view.hi).map((v) => (
            <g key={v}>
              <line className="pl-launch-chart-grid" x1={0} x2={view.plotW} y1={view.y(v)} y2={view.y(v)} />
              <text className="pl-launch-chart-axis" x={view.plotW + 8} y={view.y(v) + 4}>
                {fmt(v)}
              </text>
            </g>
          ))}
          {view.list.map((c, i) => {
            const up = c.c >= c.o;
            const cls = up ? 'up' : 'down';
            const top = view.y(Math.max(c.o, c.c));
            const bottom = view.y(Math.min(c.o, c.c));
            const vh = ((c.v || 0) / view.maxV) * (VOL_H - 6);
            return (
              <g key={c.t} className={`pl-launch-candle ${cls}`}>
                <rect className="vol" x={view.x(i) - view.body / 2} width={view.body} y={H - AXIS_H - vh} height={vh} />
                <line x1={view.x(i)} x2={view.x(i)} y1={view.y(c.h)} y2={view.y(c.l)} />
                <rect x={view.x(i) - view.body / 2} width={view.body} y={top} height={Math.max(1, bottom - top)} />
                {i % view.labelEvery === 0 && view.x(i) > 24 && view.x(i) < view.plotW - 24 && (
                  <text className="pl-launch-chart-axis" x={view.x(i)} y={H - 6} textAnchor="middle">
                    {timeLabel(c.t, interval)}
                  </text>
                )}
              </g>
            );
          })}
          {hover != null && (
            <g className="pl-launch-chart-cross">
              <line x1={view.x(hover)} x2={view.x(hover)} y1={PAD_TOP} y2={H - AXIS_H} />
              <line x1={0} x2={view.plotW} y1={view.y(view.list[hover].c)} y2={view.y(view.list[hover].c)} />
            </g>
          )}
          <line className="pl-launch-chart-last" x1={0} x2={view.plotW} y1={view.y(view.list[view.list.length - 1].c)} y2={view.y(view.list[view.list.length - 1].c)} />
        </svg>
      )}
    </div>
  );
}
