// @ts-check
'use strict';
// scripts/backtest-burn.js
// One-off study: which burn-rate estimator best predicts near-future burn from
// real Claude Code transcripts?  We can't see the 5h meter (not stored), so we
// use weighted token-cost per turn over wall-clock — the thing that drains it.
//
//   node scripts/backtest-burn.js [binSec=20] [k=9]
//
// For each estimator we report (lower is better, normalized to each session's
// mean burn so sessions aggregate fairly):
//   nRMSE-1   one-step-ahead error (predict next bin)
//   nRMSE-k   k-step error (predict the AVERAGE of the next k bins = sustained
//             burn — what "time to limit" actually cares about)
//   jitter    mean |rate_t - rate_{t-1}| of the estimate (steadiness of "time left")
// Each family is swept over its tuning knob; we keep the best by nRMSE-k.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BIN_SEC = Number(process.argv[2] || 20);
const K = Number(process.argv[3] || 9);
const WARMUP = 4;       // skip the first few bins (estimator warm-up) when scoring
const BIN_MS = BIN_SEC * 1000;

// Rough Anthropic price ratios in input-token-equivalents (the meter-drain proxy).
function turnCost(/** @type {any} */ u) {
  return (u.output_tokens || 0) * 5
    + (u.cache_creation_input_tokens || 0) * 1.25
    + (u.input_tokens || 0) * 1
    + (u.cache_read_input_tokens || 0) * 0.1;
}

function loadSeries() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  /** @type {string[]} */
  const files = [];
  for (const d of fs.readdirSync(base)) {
    const dir = path.join(base, d);
    let st; try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) files.push(path.join(dir, f));
  }
  /** @type {{name:string, bins:number[]}[]} */
  const series = [];
  for (const f of files) {
    /** @type {{t:number,c:number}[]} */
    const pts = [];
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const ln of txt.split('\n')) {
      if (!ln) continue;
      let d; try { d = JSON.parse(ln); } catch { continue; }
      const u = d.message && d.message.usage;
      const ts = d.ts || d.timestamp;
      if (!u || !ts) continue;
      const t = Date.parse(ts);
      if (!isFinite(t)) continue;
      pts.push({ t, c: turnCost(u) });
    }
    if (pts.length < 8) continue;
    pts.sort((a, b) => a.t - b.t);
    const t0 = pts[0].t, tN = pts[pts.length - 1].t;
    const n = Math.floor((tN - t0) / BIN_MS) + 1;
    if (n < WARMUP + K + 3) continue;
    const bins = new Array(n).fill(0);
    for (const p of pts) bins[Math.min(n - 1, Math.floor((p.t - t0) / BIN_MS))] += p.c;
    series.push({ name: path.basename(f).slice(0, 8), bins });
  }
  return series;
}

// --- Estimators: each returns pred1[t] = forecast of bin t using only bins < t.
function estWindow(/** @type {number[]} */ b, /** @type {number} */ W) {
  const p = new Array(b.length).fill(0);
  for (let t = 1; t < b.length; t++) {
    const lo = Math.max(0, t - W); let s = 0;
    for (let i = lo; i < t; i++) s += b[i];
    p[t] = s / (t - lo);
  }
  return p;
}
function estEwma(/** @type {number[]} */ b, /** @type {number} */ a) {
  const p = new Array(b.length).fill(0);
  let L = b[0];
  for (let t = 1; t < b.length; t++) { p[t] = L; L = a * b[t] + (1 - a) * L; }
  return p;
}
function estKalmanLevel(/** @type {number[]} */ b, /** @type {number} */ qr) {
  const p = new Array(b.length).fill(0);
  const R = 1, Q = qr; let L = b[0], P = 1;
  for (let t = 1; t < b.length; t++) {
    const Lp = L, Pp = P + Q;           // predict (random-walk level)
    p[t] = Lp;
    const Kg = Pp / (Pp + R);            // update with bin t
    L = Lp + Kg * (b[t] - Lp); P = (1 - Kg) * Pp;
  }
  return p;
}
function estKalmanTrend(/** @type {number[]} */ b, /** @type {number} */ qr) {
  const p = new Array(b.length).fill(0);
  const R = 1, Q = qr; let L = b[0], V = 0, Pl = 1, Pv = 1;
  for (let t = 1; t < b.length; t++) {
    const Lp = L + V, Vp = V;            // predict (local linear trend)
    const Plp = Pl + Pv + Q, Pvp = Pv + Q;
    p[t] = Lp;
    const Kg = Plp / (Plp + R);
    const innov = b[t] - Lp;
    L = Lp + Kg * innov; V = Vp + (Pvp / (Plp + R)) * innov;
    Pl = (1 - Kg) * Plp; Pv = Pvp * (1 - Pvp / (Plp + R));
  }
  return p;
}
const estPersistence = (/** @type {number[]} */ b) => b.map((_, t) => (t ? b[t - 1] : 0));

// --- Scoring: normalized RMSE (1-step & k-step) + jitter, aggregated over sessions.
function score(/** @type {{name:string,bins:number[]}[]} */ series, /** @type {(b:number[])=>number[]} */ est) {
  let se1 = 0, n1 = 0, seK = 0, nK = 0, jit = 0, nj = 0;
  for (const { bins } of series) {
    const pred = est(bins);
    const mean = bins.reduce((a, x) => a + x, 0) / bins.length || 1;
    for (let t = WARMUP; t < bins.length; t++) {
      const e1 = (pred[t] - bins[t]) / mean; se1 += e1 * e1; n1++;
      if (t + K <= bins.length) {
        let s = 0; for (let i = t; i < t + K; i++) s += bins[i];
        const eK = (pred[t] - s / K) / mean; seK += eK * eK; nK++;
      }
      if (t > WARMUP) { jit += Math.abs(pred[t] - pred[t - 1]) / mean; nj++; }
    }
  }
  return { rmse1: Math.sqrt(se1 / n1), rmseK: Math.sqrt(seK / nK), jitter: jit / nj };
}

function best(/** @type {any} */ series, /** @type {(p:number)=>(b:number[])=>number[]} */ make, /** @type {number[]} */ grid) {
  let bestR = null;
  for (const p of grid) {
    const s = score(series, make(p));
    if (!bestR || s.rmseK < bestR.s.rmseK) bestR = { p, s };
  }
  return bestR;
}

const series = loadSeries();
const bins = series.reduce((a, s) => a + s.bins.length, 0);
console.log(`\nbin=${BIN_SEC}s  k=${K} (~${(K * BIN_SEC / 60).toFixed(1)}min lookahead)  sessions=${series.length}  bins=${bins}\n`);

const rows = [
  ['persistence (last bin)', { p: '-', s: score(series, estPersistence) }],
  ['trailing window (current)', best(series, (W) => (b) => estWindow(b, W), [2, 3, 4, 6, 8, 12])],
  ['EWMA', best(series, (a) => (b) => estEwma(b, a), [0.1, 0.2, 0.3, 0.4, 0.5, 0.7])],
  ['Kalman local-level', best(series, (q) => (b) => estKalmanLevel(b, q), [0.01, 0.03, 0.1, 0.3, 1])],
  ['Kalman linear-trend', best(series, (q) => (b) => estKalmanTrend(b, q), [0.01, 0.03, 0.1, 0.3, 1])],
];

console.log('estimator                 param   nRMSE-1  nRMSE-k   jitter');
console.log('────────────────────────────────────────────────────────────');
for (const [name, r] of rows) {
  const s = r.s;
  console.log(
    name.padEnd(25) + ' ' +
    String(r.p).padStart(5) + '   ' +
    s.rmse1.toFixed(3).padStart(6) + '   ' +
    s.rmseK.toFixed(3).padStart(6) + '   ' +
    s.jitter.toFixed(3).padStart(6)
  );
}
const ranked = rows.slice(1).sort((a, b) => a[1].s.rmseK - b[1].s.rmseK);
console.log('\nbest sustained (nRMSE-k): ' + ranked[0][0] + ' @ ' + ranked[0][1].p);
