// src/index.ts

import express from "express";
// express is the web server framework 

import cors from "cors";
// CORS just allows browser/frontends on other origins to call this api

import { FX_DATA, FxPairKey } from "./fxData";
// FX_DATA i a nice in memory Fx dataset 
import { closesToReturns, simulateCFaR, simulateHedgedCFaR } from "./sim/monteCarlo";
// so core model functions convert closes into returns and run unhedged CFaR and run hedged CFaR

const app = express();
// this create the Express app instance

app.use(cors());
// Enables CORS for all routes

app.use(express.json());
// this parses the incoming JSON bodies so req.body works

app.get("/health", (_req, res) => {
  // a nice simple health endpoint for checking server is alive
  res.json({ ok: true });
});

app.post("/api/cfar/run", (req, res) => {
  // This is main ApI endpoint, runs Monte Carlo CFAR simulation using inputs from the request body
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
    // This just reads the required and optional parameters from the incoming JSON payload

    if (!homeCcy || !exposureCcy) {
      // just basic validation, must include the currencies to define a pair
      return res.status(400).json({ error: "homeCcy and exposureCcy required" });
    }

    const horizon = Number.isFinite(months as number) ? Number(months) : 12;
    // convert months to a number and default to 12 if not provided

    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) {
      // guardrails this only allow 1–60 months
      return res.status(400).json({ error: "months must be 1–60" });
    }

    const simsNum = Number.isFinite(sims as number) ? Number(sims) : 5000;
    // convert the sims to a number anf default to 5000 if not provided

    if (!Number.isInteger(simsNum) || simsNum < 100 || simsNum > 200000) {
      // Guardrails here simulation count must be within a safe range
      return res.status(400).json({ error: "sims must be 100–200000" });
    }

    if (!Array.isArray(exposures) || exposures.length !== horizon) {
      // this just syas exposures must be an array with one value per month of the horizon
      return res.status(400).json({ error: `exposures must be length ${horizon}` });
    }

    // validate forwardRate optional
    let fwd: number | null = null;
    // forward rate is optional null means hedged results are unavailable

    if (forwardRate !== undefined && forwardRate !== null && forwardRate !== ("" as any)) {
      // if forwardRate was provided try to parse it
      const n = Number(forwardRate);
      if (!Number.isFinite(n) || n <= 0) {
        // forward rate must be a positive finite number
        return res.status(400).json({ error: "forwardRate must be a positive number" });
      }
      fwd = n;
      // thid stores validated forward rate
    }

    // validate hedgeRatio optional defaults to 0
    let hr = 0;
    // hedge ratio defaults to 0 meaningfully unhedged

    if (hedgeRatio !== undefined && hedgeRatio !== null && hedgeRatio !== ("" as any)) {
      // If hedgeRatio was provided try to parse it
      const n = Number(hedgeRatio);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        // Hedge ratio must be within [0,1]
        return res.status(400).json({ error: "hedgeRatio must be between 0 and 1" });
      }
      hr = n;
      // Store validated hedge ratio
    }

    const pairKey = `${homeCcy}${exposureCcy}` as FxPairKey;
    // this builds the FX pair key (e.g. "GBP" + "USD" => "GBPUSD")

    const pair = FX_DATA[pairKey];
    // this is for lookup the FX data for this pair spot + historical closes

    if (!pair) {
      // Makes so reject unknown pairs no dataset loaded for them
      return res.status(400).json({ error: `No FX data for pair ${pairKey}` });
    }

    const monthlyReturns = closesToReturns(pair.closes);
    // Converts the historical closing prices into a list of monthly returns

    const minHist = Math.min(...pair.closes);
    const maxHist = Math.max(...pair.closes);
    // Compute min andmax historical close for later clamping bounds

    // Always compute unhedged
    const unhedged = simulateCFaR({
      // runs the unhedged Monte Carlo simulation to produce outcome distribution + CFaR
      spot: pair.spot,
      monthlyReturns,
      exposures,
      months: horizon,
      sims: simsNum,
      clampLower: minHist * 0.85,
      clampUpper: maxHist * 1.15,
      // the clamp prevents simulated FX levels from going unrealistically beyond history
    });

    // here if no forward rate we cannot compute hedged
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

    // no hedging blocks available without a forward rate
        unhedged: unhedged,
        fullyHedged: null,
        selected: null,

        hedged: null,
      });
    }

    // Selected hedge ratio (slider %)
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

// 100% hedged
    const pack100 = simulateHedgedCFaR({
      spot: pair.spot,
      monthlyReturns,
      exposures,
      months: horizon,
      sims: simsNum,
      clampLower: minHist * 0.85,
      clampUpper: maxHist * 1.15,
      hedgeRatio: 1,
      forwardRate: fwd,
    }); 

    return res.json({
      // Returns response payload used by the UI and callers
      pair: pairKey,
      spot: pair.spot,
      months: horizon,
      sims: simsNum,
      forwardRate: fwd,
      hedgeRatio: hr,

      // keep existing fields as UNHEDGED so the old UI still works
      mean: pack.unhedged.mean,
      p5: pack.unhedged.p5,
      cfar: pack.unhedged.cfar,
      hist: pack.unhedged.hist,

      unhedged: pack.unhedged,
      fullyHedged: pack100.hedged,
      selected: pack.hedged,

      // hedged block
      hedged: {
        // hedged results + calculated risk reduction
        mean: pack.hedged.mean,
        p5: pack.hedged.p5,
        cfar: pack.hedged.cfar,
        hist: pack.hedged.hist,
        riskReductionPct: pack.riskReductionPct,
      },
    });
  } catch (err: any) {
    // This catches unexpected errors and return a safe HTTP 500 response
    return res.status(500).json({ error: err.message ?? "Unknown error" });
  }
});

app.get("/", (_req, res) => {
  // root route serves a self-contained HTML page to test the API without a separate frontend

  const currencies = Array.from(
    // buildS a unique list of currencies by splitting pair keys like GBPUSD into ["GBP","USD"]
    new Set(Object.keys(FX_DATA).flatMap((k) => [k.slice(0, 3), k.slice(3, 6)]))
  ).sort();
  // sorts currencies alphabetically for the UI dropdown

  const pairs = Object.keys(FX_DATA);
  //  available FX pairs used by the UI logic

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

  <!-- the hedge ratio slider -->
  <div style="min-width:240px;">
    <label style="display:block;font-size:12px;opacity:.7;">
      Hedge ratio: <b id="hrLabel">0%</b>
    </label>
    <input id="hr" type="range" min="0" max="100" value="0" step="5" style="width:240px;"/>
  </div>

  <button onclick="run()" style="padding:6px 12px;">Run</button>
</div>

<!-- results: Unhedged -->
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

<!-- results: Hedged -->
<div id="hedgedBox" style="margin-top:14px; padding:12px; background:#f6f6f6; border-radius:8px;">
  <div style="font-size:14px; font-weight:600; margin-bottom:8px;">
    Results (Selected hedge ratio)
  </div>

  <div style="display:grid; grid-template-columns: 260px 1fr; row-gap:6px; column-gap:12px; font-size:13px;">
    <div>Hedged expected outcome (mean)</div><div><b id="hMeanMoney">-</b></div>
    <div>Hedged worst 5% outcome (p5)</div><div><b id="hP5Money">-</b></div>
    <div>Hedged CFaR (mean − p5)</div><div><b id="hCfarMoney">-</b></div>
    <div>Risk reduction</div><div><b id="riskRed">-</b></div>
  </div>

<!-- results: Fully Hedged -->
<div id="fullyHedgedBox" style="margin-top:14px; padding:12px; background:#f6f6f6; border-radius:8px;">
  <div style="font-size:14px; font-weight:600; margin-bottom:8px;">
    Results (100% hedged)
  </div>

  <div style="display:grid; grid-template-columns: 260px 1fr; row-gap:6px; column-gap:12px; font-size:13px;">
    <div>Fully hedged expected outcome (mean)</div><div><b id="fhMeanMoney">-</b></div>
    <div>Fully hedged worst 5% outcome (p5)</div><div><b id="fhP5Money">-</b></div>
    <div>Fully hedged CFaR (mean − p5)</div><div><b id="fhCfarMoney">-</b></div>
  </div>

  <div style="font-size:12px;opacity:.7;margin-top:8px;">
    This is the “locked” forward outcome at 100% hedge.
  </div>
</div>

  
  <div style="font-size:12px;opacity:.7;margin-top:8px;">
    Enter a forward rate to compute hedged results.
  </div>
</div>

<!-- histogram controls -->
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
// This injects serverside currency list into the page

const PAIRS = ${JSON.stringify(pairs)};
// Then tis inject server side pair list into the page

const homeSel = document.getElementById("home");
// the home currency dropdown

const expSel  = document.getElementById("exp");
// the exposure currency dropdown

const amtEl   = document.getElementById("amt");
// this is the monthly exposure amount input

const monthsSel = document.getElementById("months");
// months dropdown the simulation horizon

const simsEl  = document.getElementById("sims");
// Simulation count input

const fwdEl   = document.getElementById("fwd");
// Forward rate input 

const hrEl    = document.getElementById("hr");
// Hedge ratio slider input 0–100%

const hrLabel = document.getElementById("hrLabel");
// Hedge ratio label text

const outEl = document.getElementById("out");
// Raw json output display

// results unhedged
const meanMoney = document.getElementById("meanMoney");
// Unhedged mean display

const p5Money   = document.getElementById("p5Money");
// Here unhedged 5th percentile display

const cfarMoney = document.getElementById("cfarMoney");
// this is unhedged CFaR display

const monthsOut = document.getElementById("monthsOut");
// Horizon display

const simsOut   = document.getElementById("simsOut");
// Sims display

const pairOut   = document.getElementById("pairOut");
// Pair name display

const spotOut   = document.getElementById("spotOut");
// Spot rate display

const fwdOut    = document.getElementById("fwdOut");
// forward rate display

const hrOut     = document.getElementById("hrOut");
// hedge ratio display

// results hedged
const hMeanMoney = document.getElementById("hMeanMoney");
// the hedged mean display

const hP5Money   = document.getElementById("hP5Money");
// Hedged 5th percentile display

const hCfarMoney = document.getElementById("hCfarMoney");
// Hedged CfAR display

const riskRed    = document.getElementById("riskRed");
// Risk reduction % display

// results fully hedged
const fhMeanMoney = document.getElementById("fhMeanMoney");
const fhP5Money   = document.getElementById("fhP5Money");
const fhCfarMoney = document.getElementById("fhCfarMoney");

// histogram toggle
const histUn = document.getElementById("histUn");
// show unhedged histogram

const histHe = document.getElementById("histHe");
//  show hedged histogram

// chart
const barsEl = document.getElementById("bars");
// container for histogram bars

const chartWrap = document.getElementById("chartWrap");
// the wrapper used for positioning mean/p5 lines

const meanLine = document.getElementById("meanLine");
// Vertical line showing mean

const p5Line = document.getElementById("p5Line");
// Vertical line showing p5

const minVal = document.getElementById("minVal");
// Histogram min label

const maxVal = document.getElementById("maxVal");
// Histogram max label

function fill(sel, vals){
  // thus populate a <select> dropdown with options
  sel.innerHTML="";
  vals.forEach(v=>{
    const o=document.createElement("option");
    o.value=v; o.textContent=v;
    sel.appendChild(o);
  });
}

function validExp(home){
  // for a chosen home currency, list exposure currencies that exist in PAIRS
  return PAIRS.filter(p=>p.slice(0,3)===home).map(p=>p.slice(3,6));
}

function refreshExp(){
  // refreshes exposure dropdown when home currency changes
  const v = validExp(homeSel.value);
  fill(expSel, v.length ? v : CURRENCIES);
  if (v.length) {
    // Default exposure to USD if possibl otherwise first valid one
    expSel.value = v.includes("USD") ? "USD" : v[0];
  }
}

function fmtMoney(x, ccy) {
  // for format numeric results as currency for display
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 0
    }).format(n);
  } catch {
    // for fallback if currency code not supported by Intl
    return n.toLocaleString(undefined, { maximumFractionDigits: 0 }) + " " + ccy;
  }
}

function renderHist(hist, mean, p5){
  // Render histogram bars + mean and p5 vertical lines
  if (!hist || !hist.counts || !hist.counts.length) return;

  // shows histogram min/max labels
  minVal.textContent = Number(hist.min).toFixed(2);
  maxVal.textContent = Number(hist.max).toFixed(2);

  // Builds the bars
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

  // Positions mean/p5 lines within the chart using min/max scaling
  const range = (hist.max - hist.min) || 1;
  const w = chartWrap.clientWidth - 20;
  const meanX = 10 + ((mean - hist.min) / range) * w;
  const p5X = 10 + ((p5 - hist.min) / range) * w;

  meanLine.style.left = meanX + "px";
  p5Line.style.left = p5X + "px";
}

function updateHrLabel(){
  // here updates the visible % label next to the hedge ratio slider
  hrLabel.textContent = String(hrEl.value) + "%";
}

fill(homeSel, CURRENCIES);
// Populate home currency dropdown

homeSel.value = CURRENCIES.includes("GBP") ? "GBP" : CURRENCIES[0];
// Default home currency to GBP if available

fill(monthsSel, Array.from({length:24}, (_,i)=>String(i+1)));
// populate months dropdown with 1..24

monthsSel.value = "12";
// default horizon to 12 months

refreshExp();
// Populate exposure dropdown based on chosen home currency

updateHrLabel();
// Initialises rhe hedge ratio label

let lastResponse = null;
// Stores last API response so histogram toggling can rerender without rerunning

async function run(){
  // Collect current UI inputs and call the backend simulation endpoint
  const m = Number(monthsSel.value || 12);
  const sims = Number(simsEl.value || 5000);
  const amt = Number(amtEl.value || 0);

  // Forward rate is optional the empty string becomes null
  const fwdRaw = (fwdEl.value || "").trim();
  const fwdNum = fwdRaw === "" ? null : Number(fwdRaw);

  // Convert slider % to 0..1 hedge ratio
  const hrPct = Number(hrEl.value || 0);
  const hr = hrPct / 100;

  const res = await fetch("/api/cfar/run",{
    // POST request to the server API
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      // here payload matches what /api/cfar/run expects
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
  // parse JSON response from backend

  lastResponse = j;
  // Save response for histogram toggle rendering

  // Unhedged
  meanMoney.textContent = fmtMoney(j.mean, homeSel.value);
  // Display unhedged mean

  p5Money.textContent = fmtMoney(j.p5, homeSel.value);
  // Display unhedged 5th percentile

  cfarMoney.textContent = fmtMoney(j.cfar, homeSel.value);
  // Display unhedged CFaR

  monthsOut.textContent = String(j.months ?? m);
  // display horizon used

  simsOut.textContent = String(j.sims ?? sims);
  // display simulation count used

  pairOut.textContent = String(j.pair ?? "-");
  // display FX pair

  spotOut.textContent = (typeof j.spot === "number") ? j.spot.toFixed(6) : String(j.spot ?? "-");
  // display spot rate

  hrOut.textContent = Math.round((j.hedgeRatio ?? hr) * 100) + "%";
  // Display hedge ratio %

  if (j.forwardRate === null || j.forwardRate === undefined) {
    // If forward rate not provided, show "-"
    fwdOut.textContent = "-";
  } else if (typeof j.forwardRate === "number") {
    // If numeric, show with decimals
    fwdOut.textContent = j.forwardRate.toFixed(6);
  } else {
    // Otherwise show as string
    fwdOut.textContent = String(j.forwardRate);
  }

  // =====================
  // Selected hedge ratio
  // =====================
  hMeanMoney.textContent = "-";
  hP5Money.textContent   = "-";
  hCfarMoney.textContent = "-";
  riskRed.textContent    = "-";

  if (j && j.selected) {
    hMeanMoney.textContent = fmtMoney(j.selected.mean, homeSel.value);
    hP5Money.textContent   = fmtMoney(j.selected.p5, homeSel.value);
    hCfarMoney.textContent = fmtMoney(j.selected.cfar, homeSel.value);

    if (j.hedged && Number.isFinite(j.hedged.riskReductionPct)) {
      riskRed.textContent = j.hedged.riskReductionPct.toFixed(1) + "%";
    }
  }

  // =====================
  // Fully hedged (100%)
  // =====================
  if (fhMeanMoney) {
    fhMeanMoney.textContent = "-";
    fhP5Money.textContent   = "-";
    fhCfarMoney.textContent = "-";

    if (j && j.fullyHedged) {
      fhMeanMoney.textContent = fmtMoney(j.fullyHedged.mean, homeSel.value);
      fhP5Money.textContent   = fmtMoney(j.fullyHedged.p5, homeSel.value);
      fhCfarMoney.textContent = fmtMoney(j.fullyHedged.cfar, homeSel.value);
    }
  }




  // histogram: based on radio selection
  renderSelectedHist();
  // draws the chart for whichever mode is selected

  outEl.textContent = JSON.stringify(j, null, 2);
  // Show raw JSON for debugging andinspection
}

function renderSelectedHist(){
  // chooses which histogram to render based on the selected radio
  if (!lastResponse) return;

  // if hedged selected but not available fall back to unhedged
  if (histHe.checked && lastResponse.hedged && lastResponse.hedged.hist) {
    // Render hedged histogram if present
    renderHist(lastResponse.hedged.hist, lastResponse.hedged.mean, lastResponse.hedged.p5);
  } else {
    // Default render unhedged histogram
    renderHist(lastResponse.hist, lastResponse.mean, lastResponse.p5);
  }
}

homeSel.onchange = () => { refreshExp(); run(); };
// When home currency changes: refresh exposure options and rerun

expSel.onchange = run;
// When exposure currency changes rerun

monthsSel.onchange = run;
// When months changes rerun

simsEl.onchange = run;
// When sims changes rerun

fwdEl.onchange = run;
// When forward rate changes rerun

hrEl.oninput = () => { updateHrLabel(); };
// While dragging slider update % label only

hrEl.onchange = () => { updateHrLabel(); run(); };
// When slider released update label and rerun

histUn.onchange = renderSelectedHist;
// When switching histogram mode redraw chart from last response

histHe.onchange = renderSelectedHist;
// When swiitching histogram mode we redraw chart from last response

run();
// Autorun once on page load to populate results immediately
</script>
</body>
</html>
`);
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
// Uses hosting provided PORT if available otherwise  it wil default to 3001

app.listen(PORT, "0.0.0.0", () => {
  // start server and listen on all interfaces works in Docker and also cloud too
  console.log("Server running on port " + PORT);
});
