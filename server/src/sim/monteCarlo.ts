// src/sim/monteCarlo.ts

export type SimulationResult = {
  mean: number;
  p5: number;
  cfar: number;
  sims: number;
  months: number;

  hist: {
    bins: number;
    min: number;
    max: number;
    counts: number[];
  };
};

export type HedgedSimulationResult = {
  unhedged: SimulationResult;
  hedged: SimulationResult;
  hedgeRatio: number;       // 0..1
  forwardRate: number;      // all-in forward rate
  riskReductionPct: number; // 0..100
};

function mean(arr: number[]): number {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  const idx = Math.floor(p * (n - 1));
  return sortedAsc[idx];
}

function randomIndex(n: number): number {
  return Math.floor(Math.random() * n);
}

export function closesToReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(closes[i] / closes[i - 1] - 1);
  }
  return returns;
}

function buildHist(outcomes: number[]) {
  const sorted = [...outcomes].sort((a, b) => a - b);

  const bins = 30;
  let min = sorted[0];
  let max = sorted[sorted.length - 1];
  if (max === min) max = min + 1e-9;

  const counts = new Array(bins).fill(0);
  const width = (max - min) / bins;

  for (const x of outcomes) {
    let idx = Math.floor((x - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    counts[idx]++;
  }

  return { bins, min, max, counts };
}

export function simulateCFaR(params: {
  spot: number;
  monthlyReturns: number[];
  exposures: number[];
  sims?: number;
  months?: number;
  clampLower?: number;
  clampUpper?: number;
}): SimulationResult {
  const {
    spot,
    monthlyReturns,
    exposures,
    sims = 5000,
    months = 12,
    clampLower,
    clampUpper,
  } = params;

  const outcomes: number[] = new Array(sims);

  for (let k = 0; k < sims; k++) {
    let rate = spot;
    let total = 0;

    for (let t = 0; t < months; t++) {
      const r = monthlyReturns[randomIndex(monthlyReturns.length)];
      rate = rate * (1 + r);

      if (clampLower !== undefined && rate < clampLower) rate = clampLower;
      if (clampUpper !== undefined && rate > clampUpper) rate = clampUpper;

      total += exposures[t] * rate;
    }

    outcomes[k] = total;
  }

  const sorted = [...outcomes].sort((a, b) => a - b);
  const m = mean(outcomes);
  const p5 = percentile(sorted, 0.05);

  return {
    mean: m,
    p5,
    cfar: m - p5,
    sims,
    months,
    hist: buildHist(outcomes),
  };
}

/**
 * Hedged simulation:
 * - hedgeRatio of each month's exposure is converted at a fixed forwardRate
 * - the remaining (1-hedgeRatio) is converted at the simulated spot path rate
 */
export function simulateHedgedCFaR(params: {
  spot: number;
  monthlyReturns: number[];
  exposures: number[];
  sims?: number;
  months?: number;
  clampLower?: number;
  clampUpper?: number;

  hedgeRatio: number; // 0..1
  forwardRate: number; // all-in forward
}): HedgedSimulationResult {
  const {
    spot,
    monthlyReturns,
    exposures,
    sims = 5000,
    months = 12,
    clampLower,
    clampUpper,
    hedgeRatio,
    forwardRate,
  } = params;

  const unhedgedOutcomes: number[] = new Array(sims);
  const hedgedOutcomes: number[] = new Array(sims);

  for (let k = 0; k < sims; k++) {
    let rate = spot;
    let totalUnhedged = 0;
    let totalHedged = 0;

    for (let t = 0; t < months; t++) {
      const r = monthlyReturns[randomIndex(monthlyReturns.length)];
      rate = rate * (1 + r);

      if (clampLower !== undefined && rate < clampLower) rate = clampLower;
      if (clampUpper !== undefined && rate > clampUpper) rate = clampUpper;

      const exp = exposures[t];

      // Unhedged: 100% floats
      totalUnhedged += exp * rate;

      // Hedged: split exposure
      const hedgedPart = exp * hedgeRatio;
      const unhedgedPart = exp * (1 - hedgeRatio);

      totalHedged += hedgedPart * forwardRate + unhedgedPart * rate;
    }

    unhedgedOutcomes[k] = totalUnhedged;
    hedgedOutcomes[k] = totalHedged;
  }

  const summarize = (outcomes: number[]): SimulationResult => {
    const sorted = [...outcomes].sort((a, b) => a - b);
    const m = mean(outcomes);
    const p5 = percentile(sorted, 0.05);
    return {
      mean: m,
      p5,
      cfar: m - p5,
      sims,
      months,
      hist: buildHist(outcomes),
    };
  };

  const unhedged = summarize(unhedgedOutcomes);
  const hedged = summarize(hedgedOutcomes);

  const riskReductionPct =
    unhedged.cfar > 0 ? (1 - hedged.cfar / unhedged.cfar) * 100 : 0;

  return {
    unhedged,
    hedged,
    hedgeRatio,
    forwardRate,
    riskReductionPct,
  };
}
