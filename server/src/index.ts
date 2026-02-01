// src/index.ts

import express from "express";
import cors from "cors";
import { FX_DATA, FxPairKey } from "./fxData";
import { closesToReturns, simulateCFaR, simulateHedgedCFaR } from "./sim/monteCarlo";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/cfar/run", (req, res) => {
  try {
    const {
      homeCcy,
      exposureCcy,
      exposures,
      months,
      sims,
      forwardRate,
      hedgeRatio,
    } = req.body as {
      homeCcy: string;
      exposureCcy: string;
      exposures: number[];
      months?: number;
      sims?: number;
      forwardRate?: number | null;
      hedgeRatio?: number | null; // 0..1
    };

    if (!homeCcy || !exposureCcy) {
      return res.status(400).json({ error: "homeCcy and exposureCcy required" });
    }

    const horizon = Number.isFinite(months as number) ? Number(months) : 12;
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) {
      return res.status(400).json({ error: "months must be 1–60" });
    }

    const simsNum = Number.isFinite(sims as number) ? Number(sims) : 5000;
    if (!Number.isInteger(simsNum) || simsNum < 100 || simsNum > 200000) {
      return res.status(400).json({ error: "sims must be 100–200000" });
    }

    if (!Array.isArray(exposures) || exposures.length !== horizon) {
      return res.status(400).json({ error: `exposures must be length ${horizon}` });
    }

    // validate forwardRate optional
    let fwd: number | null = null;
    if (forwardRate !== undefined && forwardRate !== null && forwardRate !== ("" as any)) {
      const n = Number(forwardRate);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "forwardRate must be a positive number" });
      }
      fwd = n;
    }

    // validate hedgeRatio optional (defaults to 0)
    let hr = 0;
    if (hedgeRatio !== undefined && hedgeRatio !== null && hedgeRatio !== ("" as any)) {
      const n = Number(hedgeRatio);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        return res.status(400).json({ error: "hedgeRatio must be between 0 and 1" });
      }
      hr = n;
    }

    const pairKey = `${homeCcy}${exposureCcy}` as FxPairKey;
    const pair = FX_DATA[pairKey];
    if (!pair) {
      return res.status(400).json({ error: `No FX data for pair ${pairKey}` });
    }

    const monthlyReturns = closesToReturns(pair.closes);
    const minHist = Math.min(...pair.closes);
    const maxHist = Math.max(...pair.closes);

    // Always compute unhedged
    const unhedged = simulateCFaR({
      spot: pair.spot,
      monthlyReturns,
      exposures,
      months: horizon,
      sims: simsNum,
      clampLower: minHist * 0.85,
      clampUpper: maxHist * 1.15,
    });

    // If no forward rate, we cannot compute hedged
    if (fwd === null) {
      return res.json({
        pair: pairKey,
        spot: pair.spot,
        months: unhedged.months,
        sims: unhedged.sims,
        forwardRate: null,
        hedgeRatio: hr,

        // keep existing fields as unhedged
        mean: unhedged.mean,
        p5: unhedged.p5,
        cfar: unhedged.cfar,
        hist: unhedged.hist,

        hedged: null,
      });
    }

    // Compute hedged pack
    const pack = simulateHedgedCFaR({
      spot: pair.spot,
      monthlyReturns,
      exposures,
      months: horizon,
      sims: simsNum,
      clampLower: minHist * 0.85,
      clampUpper: maxHist * 1.15,
      hedgeRatio: hr,
      forwardRate: fwd,
    });

    return res.json({
      pair: pairKey,
      spot: pair.spot,
      months: horizon,
      sims: simsNum,
      forwardRate: fwd,
      hedgeRatio: hr,

      // keep existing fields as UNHEDGED (so old UI still works)
      mean: pack.unhedged.mean,
      p5: pack.unhedged.p5,
      cfar: pack.unhedged.cfar,
      hist: pack.unhedged.hist,

      // NEW: hedged block
      hedged: {
        mean: pack.hedged.mean,
        p5: pack.hedged.p5,
        cfar: pack.hedged.cfar,
        hist: pack.hedged.hist,
        riskReductionPct: pack.riskReductionPct,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message ?? "Unknown error" });
  }
});

app.get("/", (_req, res) => {
  const currencies = Array.from(
    new Set(Object.keys(FX_DATA).flatMap((k) => [k.slice(0, 3), k.slice(3, 6)]))
  ).sort();

  const pairs = Object.keys(FX_DATA);

  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>CFaR Test</title>
</head>
<body style="font-family:sans-serif;max-width:980px;margin:24px;">
<h2>CFaR Test</h2>

<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;">
  <div>
    <label style="display:block;font-size:12px;opacity:.7;">Home</label>
    <select id="home"></select>
  </div>

  <div>
    <label style="display:block;font-size:12px;opacity:.7;">Exposure</label>
    <select id="exp"></select>
  </div>

  <div>
    <label style="display:block;font-size:12px;opacity:.7;">Monthly exposure</label>
    <input id="amt" type="number" value="100000" step="1000" style="width:180px;"/>
  </div>

  <div>
    <label style="display:block;font-size:12px;opacity:.7;">Months</label>
    <select id="months"></select>
  </div>

  <div>
    <label style="display:block;font-size:12px;opacity:.7;"># Sims</label>
    <input id="sims" type="number" value="5000" step="500" min="100" style="width:140px;"/>
  </div>

  <div>
    <label style="display:block;font-size:12px;opacity:.7;">Forward rate (all-in)</label>
    <input id="fwd" type="number" step="0.000001" placeholder="Required for hedged" style="width:180px;"/>
  </div>

  <!-- Hedge ratio slider -->
  <div style="min-width:240px;">
    <label style="display:block;font-size:12px;opacity:.7;">
      Hedge ratio: <b id="hrLabel">0%</b>
    </label>
    <input id="hr" type="range" min="0" max="100" value="0" step="5" style="width:240px;"/>
  </div>

  <button onclick="run()" style="padding:6px 12px;">Run</button>
</div>

<!-- Results: Unhedged -->
<div id="results" style="margin-top:14px; padding:12px; background:#f6f6f6; border-radius:8px;">
  <div style="font-size:14px; font-weight:600; margin-bottom:8px;">Results (Unhedged)</div>

  <div style="display:grid; grid-template-columns: 260px 1fr; row-gap:6px; column-gap:12px; font-size:13px;">
    <div>Expected outcome (mean)</div><div><b id="meanMoney">-</b></div>
    <div>Worst 5% outcome (p5)</div><div><b id="p5Money">-</b></div>
    <div>CFaR (mean − p5)</div><div><b id="cfarMoney">-</b></div>
    <div>Horizon</div><div><span id="monthsOut">-</span> months</div>
    <div>Simulations</div><div><span id="simsOut">-</span></div>
    <div>Pair / spot</div><div><span id="pairOut">-</span> @ <span id="spotOut">-</span></div>
    <div>Forward rate (all-in)</div><div><span id="fwdOut">-</span></div>
    <div>Hedge ratio</div><div><span id="hrOut">-</span></div>
  </div>
</div>

<!-- Results: Hedged -->
<div id="hedgedBox" style="margin-top:14px; padding:12px; background:#f6f6f6; border-radius:8px;">
  <div style="font-size:14px; font-weight:600; margin-bottom:8px;">Results (Hedged)</div>

  <div style="display:grid; grid-template-columns: 260px 1fr; row-gap:6px; column-gap:12px; font-size:13px;">
    <div>Hedged expected outcome (mean)</div><div><b id="hMeanMoney">-</b></div>
    <div>Hedged worst 5% outcome (p5)</div><div><b id="hP5Money">-</b></div>
    <div>Hedged CFaR (mean − p5)</div><div><b id="hCfarMoney">-</b></div>
    <div>Risk reduction</div><div><b id="riskRed">-</b></div>
  </div>

  <div style="font-size:12px;opacity:.7;margin-top:8px;">
    Enter a forward rate to compute hedged results.
  </div>
</div>

<!-- Histogram controls -->
<div style="margin-top:16px; display:flex; gap:16px; align-items:center; font-size:12px; opacity:.85;">
  <div><b>Histogram:</b></div>
  <label style="display:flex; gap:6px; align-items:center;">
    <input type="radio" name="histMode" id="histUn" checked />
    Unhedged
  </label>
  <label style="display:flex; gap:6px; align-items:center;">
    <input type="radio" name="histMode" id="histHe" />
    Hedged
  </label>
  <div style="opacity:.7;">(Hedged only works if you entered a forward rate.)</div>
</div>

<div style="margin-top:8px;">
  <div style="font-size:12px;opacity:.75;margin-bottom:6px;">
    Outcome distribution (histogram).
    <span style="margin-left:10px;">Mean line = darker</span>
    <span style="margin-left:10px;">P5 line = lighter</span>
  </div>

  <div id="chartWrap" style="position:relative;height:200px;background:#f6f6f6;padding:10px;border-radius:8px;">
    <div id="bars" style="display:flex;align-items:flex-end;height:180px;gap:2px;"></div>
    <div id="meanLine" style="position:absolute;top:10px;bottom:10px;width:2px;background:black;opacity:.7;"></div>
    <div id="p5Line" style="position:absolute;top:10px;bottom:10px;width:2px;background:black;opacity:.35;"></div>

    <div style="position:absolute;left:10px;bottom:6px;font-size:11px;opacity:.6;">
      min: <span id="minVal">-</span>
    </div>
    <div style="position:absolute;right:10px;bottom:6px;font-size:11px;opacity:.6;">
      max: <span id="maxVal">-</span>
    </div>
  </div>
</div>

<pre id="out" style="margin-top:12px;background:#f6f6f6;padding:12px;border-radius:8px;"></pre>

<script>
const CURRENCIES = ${JSON.stringify(currencies)};
const PAIRS = ${JSON.stringify(pairs)};

const homeSel = document.getElementById("home");
const expSel  = document.getElementById("exp");
const amtEl   = document.getElementById("amt");
const monthsSel = document.getElementById("months");
const simsEl  = document.getElementById("sims");
const fwdEl   = document.getElementById("fwd");
const hrEl    = document.getElementById("hr");
const hrLabel = document.getElementById("hrLabel");

const outEl = document.getElementById("out");

// results unhedged
const meanMoney = document.getElementById("meanMoney");
const p5Money   = document.getElementById("p5Money");
const cfarMoney = document.getElementById("cfarMoney");
const monthsOut = document.getElementById("monthsOut");
const simsOut   = document.getElementById("simsOut");
const pairOut   = document.getElementById("pairOut");
const spotOut   = document.getElementById("spotOut");
const fwdOut    = document.getElementById("fwdOut");
const hrOut     = document.getElementById("hrOut");

// results hedged
const hMeanMoney = document.getElementById("hMeanMoney");
const hP5Money   = document.getElementById("hP5Money");
const hCfarMoney = document.getElementById("hCfarMoney");
const riskRed    = document.getElementById("riskRed");

// histogram toggle
const histUn = document.getElementById("histUn");
const histHe = document.getElementById("histHe");

// chart
const barsEl = document.getElementById("bars");
const chartWrap = document.getElementById("chartWrap");
const meanLine = document.getElementById("meanLine");
const p5Line = document.getElementById("p5Line");
const minVal = document.getElementById("minVal");
const maxVal = document.getElementById("maxVal");

function fill(sel, vals){
  sel.innerHTML="";
  vals.forEach(v=>{
    const o=document.createElement("option");
    o.value=v; o.textContent=v;
    sel.appendChild(o);
  });
}

function validExp(home){
  return PAIRS.filter(p=>p.slice(0,3)===home).map(p=>p.slice(3,6));
}

function refreshExp(){
  const v = validExp(homeSel.value);
  fill(expSel, v.length ? v : CURRENCIES);
  if (v.length) {
    expSel.value = v.includes("USD") ? "USD" : v[0];
  }
}

function fmtMoney(x, ccy) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 0
    }).format(n);
  } catch {
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " " + ccy;
  }
}

function renderHist(hist, mean, p5){
  if (!hist || !hist.counts || !hist.counts.length) return;

  minVal.textContent = Number(hist.min).toFixed(2);
  maxVal.textContent = Number(hist.max).toFixed(2);

  barsEl.innerHTML="";
  const maxCount = Math.max(...hist.counts);
  hist.counts.forEach(c=>{
    const b=document.createElement("div");
    b.style.flex="1";
    b.style.height = (maxCount ? (c/maxCount*180) : 0) + "px";
    b.style.background="black";
    b.style.opacity="0.25";
    barsEl.appendChild(b);
  });

  const range = (hist.max - hist.min) || 1;
  const w = chartWrap.clientWidth - 20;
  const meanX = 10 + ((mean - hist.min) / range) * w;
  const p5X = 10 + ((p5 - hist.min) / range) * w;

  meanLine.style.left = meanX + "px";
  p5Line.style.left = p5X + "px";
}

function updateHrLabel(){
  hrLabel.textContent = String(hrEl.value) + "%";
}

fill(homeSel, CURRENCIES);
homeSel.value = CURRENCIES.includes("GBP") ? "GBP" : CURRENCIES[0];

fill(monthsSel, Array.from({length:24}, (_,i)=>String(i+1)));
monthsSel.value = "12";

refreshExp();
updateHrLabel();

let lastResponse = null;

async function run(){
  const m = Number(monthsSel.value || 12);
  const sims = Number(simsEl.value || 5000);
  const amt = Number(amtEl.value || 0);

  const fwdRaw = (fwdEl.value || "").trim();
  const fwdNum = fwdRaw === "" ? null : Number(fwdRaw);

  const hrPct = Number(hrEl.value || 0);
  const hr = hrPct / 100;

  const res = await fetch("/api/cfar/run",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      homeCcy: homeSel.value,
      exposureCcy: expSel.value,
      months: m,
      sims: sims,
      exposures: Array(m).fill(amt),
      forwardRate: fwdNum,
      hedgeRatio: hr
    })
  });

  const j = await res.json();
  lastResponse = j;

  // Unhedged
  meanMoney.textContent = fmtMoney(j.mean, homeSel.value);
  p5Money.textContent = fmtMoney(j.p5, homeSel.value);
  cfarMoney.textContent = fmtMoney(j.cfar, homeSel.value);
  monthsOut.textContent = String(j.months ?? m);
  simsOut.textContent = String(j.sims ?? sims);
  pairOut.textContent = String(j.pair ?? "-");
  spotOut.textContent = (typeof j.spot === "number") ? j.spot.toFixed(6) : String(j.spot ?? "-");
  hrOut.textContent = Math.round((j.hedgeRatio ?? hr) * 100) + "%";

  if (j.forwardRate === null || j.forwardRate === undefined) {
    fwdOut.textContent = "-";
  } else if (typeof j.forwardRate === "number") {
    fwdOut.textContent = j.forwardRate.toFixed(6);
  } else {
    fwdOut.textContent = String(j.forwardRate);
  }

  // Hedged
  if (j.hedged) {
    hMeanMoney.textContent = fmtMoney(j.hedged.mean, homeSel.value);
    hP5Money.textContent = fmtMoney(j.hedged.p5, homeSel.value);
    hCfarMoney.textContent = fmtMoney(j.hedged.cfar, homeSel.value);
    riskRed.textContent = (Number.isFinite(j.hedged.riskReductionPct))
      ? j.hedged.riskReductionPct.toFixed(1) + "%"
      : "-";
  } else {
    hMeanMoney.textContent = "-";
    hP5Money.textContent = "-";
    hCfarMoney.textContent = "-";
    riskRed.textContent = "-";
  }

  // Histogram: based on radio selection
  renderSelectedHist();

  outEl.textContent = JSON.stringify(j, null, 2);
}

function renderSelectedHist(){
  if (!lastResponse) return;

  // if hedged selected but not available, fall back to unhedged
  if (histHe.checked && lastResponse.hedged && lastResponse.hedged.hist) {
    renderHist(lastResponse.hedged.hist, lastResponse.hedged.mean, lastResponse.hedged.p5);
  } else {
    renderHist(lastResponse.hist, lastResponse.mean, lastResponse.p5);
  }
}

homeSel.onchange = () => { refreshExp(); run(); };
expSel.onchange = run;
monthsSel.onchange = run;
simsEl.onchange = run;
fwdEl.onchange = run;

hrEl.oninput = () => { updateHrLabel(); };
hrEl.onchange = () => { updateHrLabel(); run(); };

histUn.onchange = renderSelectedHist;
histHe.onchange = renderSelectedHist;

run();
</script>
</body>
</html>
`);
});

const PORT = Number(process.env.PORT) || 3001;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});

