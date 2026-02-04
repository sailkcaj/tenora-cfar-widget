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
  hedgeRatio: number;
  forwardRate: number;
  riskReductionPct: number;
};

export type FXPathSet = {
  spots: number[][]; // spots[sim][t], t = 0..months
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

  const outcomes = new Array<number>(sims);

  for (let k = 0; k < sims; k++) {
    let rate = spot;
    let total = 0;

    for (let t = 0; t < months; t++) {
      const r = monthlyReturns[randomIndex(monthlyReturns.length)];
      rate *= 1 + r;

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

export function simulateFXPaths(params: {
  spot: number;
  monthlyReturns: number[];
  sims?: number;
  months?: number;
  clampLower?: number;
  clampUpper?: number;
}): FXPathSet {
  const {
    spot,
    monthlyReturns,
    sims = 5000,
    months = 12,
    clampLower,
    clampUpper,
  } = params;

  const spots: number[][] = new Array(sims);

  for (let k = 0; k < sims; k++) {
    const path = new Array<number>(months + 1);
    let rate = spot;
    path[0] = rate;

    for (let t = 1; t <= months; t++) {
      const r = monthlyReturns[randomIndex(monthlyReturns.length)];
      rate *= 1 + r;

      if (clampLower !== undefined && rate < clampLower) rate = clampLower;
      if (clampUpper !== undefined && rate > clampUpper) rate = clampUpper;

      path[t] = rate;
    }

    spots[k] = path;
  }

  return { spots };
}

export function applyHedgingToPaths(params: {
  fxPaths: FXPathSet;
  exposures: number[];
  hedgeRatio: number;
  forwardRate: number;
  hedgeTenorMonths?: number;
}): HedgedSimulationResult {
  const {
    fxPaths,
    exposures,
    hedgeRatio,
    forwardRate,
    hedgeTenorMonths = exposures.length,
  } = params;

  const sims = fxPaths.spots.length;
  const months = exposures.length;
  const forwardFactor = forwardRate / fxPaths.spots[0][0];

  const unhedgedOutcomes = new Array<number>(sims);
  const hedgedOutcomes = new Array<number>(sims);

  type Hedge = {
    settleMonth: number;
    forwardRate: number;
    notional: number;
  };

  for (let k = 0; k < sims; k++) {
    const path = fxPaths.spots[k];
    let totalUnhedged = 0;
    let totalHedged = 0;
    let hedgeBook: Hedge[] = [];

    for (let t = 0; t < months; t++) {
      const exp = exposures[t];
      const entrySpot = path[t];
      const settleSpot = path[t + 1];

      const hedgeTargetMonth = t + hedgeTenorMonths;
      if (hedgeTargetMonth < exposures.length) {
        hedgeBook.push({
          settleMonth: hedgeTargetMonth,
          forwardRate: entrySpot * forwardFactor,
          notional: exposures[hedgeTargetMonth] * hedgeRatio,
        });
      }

      let hedgedCashflow = 0;
      hedgeBook = hedgeBook.filter(h => {
        if (h.settleMonth === t) {
          hedgedCashflow += h.notional * h.forwardRate;
          return false;
        }
        return true;
      });

      totalHedged += hedgedCashflow + exp * (1 - hedgeRatio) * settleSpot;
      totalUnhedged += exp * settleSpot;
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

  return {
    unhedged,
    hedged,
    hedgeRatio,
    forwardRate,
    riskReductionPct:
      unhedged.cfar > 0 ? (1 - hedged.cfar / unhedged.cfar) * 100 : 0,
  };
}

export function simulateHedgedCFaR(params: {
  spot: number;
  monthlyReturns: number[];
  exposures: number[];
  sims?: number;
  months?: number;
  clampLower?: number;
  clampUpper?: number;
  hedgeRatio: number;
  forwardRate: number;
  hedgeTenorMonths?: number;
}): HedgedSimulationResult {
  const fxPaths = simulateFXPaths(params);

  return applyHedgingToPaths({
    fxPaths,
    exposures: params.exposures,
    hedgeRatio: params.hedgeRatio,
    forwardRate: params.forwardRate,
    hedgeTenorMonths: params.hedgeTenorMonths,
  });
}