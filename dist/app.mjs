import {
  DEFAULT_TRADE, INSTRUMENTS, LAST_ENTRY_DAY, MAX_HOLD, PRESETS,
  createShocks, entryImpliedVolatility, marketAtAge, mixSamples, simulate, summarize, survivalAtAge,
} from './model.mjs';

const $ = id => document.getElementById(id);
const scenarios = PRESETS.map(preset => ({ ...preset, market: { ...preset.market } }));
const trade = { ...DEFAULT_TRADE };
const manualCall = { impliedVolatility: 2.05 };
const shocks = createShocks();
const weights = [40, 30, 30];
let selected = 0;
let frame = 0;
let chartFrame = 0;
let charts = {};
let cache = { ages: new Map(), comparisons: new Map() };

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
function format(value, unit, signed = false) {
  const rounded = Math.round((Math.abs(value) + 1e-10) * 10) / 10;
  const sign = rounded === 0 ? '' : value < 0 ? '−' : signed ? '+' : '';
  return sign + number.format(rounded) + unit;
}
const pct = (value, signed = false) => format(value * 100, '%', signed);
function odds(value) {
  const rounded = Math.round(value * 100);
  if (rounded === 0 && value > 0) return '<1%';
  if (rounded === 100 && value < 1) return '>99%';
  return rounded + '%';
}
const points = value => format(value * 100, ' pp', true);

const marketFields = [
  ['buyingStrength', 'Initial expected daily gain', 0, 12, 0.5, '%', 100],
  ['pressureDays', 'Days before buying starts to fade', 0, 45, 1, ' days'],
  ['fadeDays', 'Days for buying to fade', 1, 45, 1, ' days'],
  ['volatility', 'Daily volatility', 0, 40, 1, '%', 100],
  ['initialBreakRisk', 'Initial daily break chance', 0, 35, 0.5, '%', 100],
  ['breakRiskSlope', 'Daily increase in break chance', 0, 4, 0.1, ' pp', 100],
  ['minBreakDrop', 'Smallest break shock', 0, 95, 1, '%', 100],
  ['maxBreakDrop', 'Largest break shock', 0, 95, 1, '%', 100],
];
const primaryFields = [
  ['day', 'Rally age at entry', 0, LAST_ENTRY_DAY, 1, ' days'],
  ['allocation', 'Portfolio allocation', 1, 25, 1, '%', 100],
];
const tradeFields = [
  ['hold', 'Maximum holding period', 1, MAX_HOLD, 1, ' days'],
  ['takeProfit', 'Take-profit', 0, 500, 10, '%', 100],
  ['trailingStop', 'Trailing stop', 0, 70, 5, '%', 100],
  ['cost', 'Shares and margin fee rate', 0, 5, 0.25, '%', 100],
  ['penaltyChance', 'Chance of penalty on large moves', 0, 100, 5, '%', 100],
  ['exitPenalty', 'Exit price penalty', 0, 30, 1, '%', 100],
];
const marginFields = [
  ['leverage', 'Initial leverage', 1, 4, 0.25, '×'],
  ['maintenance', 'Maintenance equity ratio', 10, 25, 1, '%', 100],
  ['marginRate', 'Annual margin interest', 0, 25, 1, '%', 100],
];
const callFields = [
  ['callMaturity', 'Days to expiration at entry', 3, 30, 1, ' days'],
  ['strike', 'Strike (% of entry price)', 105, 150, 5, '%', 100],
  ['callFee', 'Call round-trip fee rate', 0, 25, 0.5, '%', 100],
  ['postBreakIvMultiplier', 'Post-break IV (% of entry IV)', 25, 200, 5, '%', 100],
];
const ivFields = [['impliedVolatility', 'Fixed annual implied volatility', 30, 650, 5, '%', 100]];

function addFields(container, definitions, getState, onInput = () => {}) {
  for (const [key, label, min, max, step, unit, scale = 1] of definitions) {
    const id = 'field-' + key;
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML =
      '<label for="' + id + '">' + label + ' <output id="value-' + key + '" aria-hidden="true"></output></label>' +
      '<input id="' + id + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '">';
    container.append(field);
    $(id).addEventListener('input', event => {
      getState()[key] = Number(event.target.value) / scale;
      onInput(key);
      syncFields(definitions, getState());
      requestRender();
    });
  }
}

function syncFields(definitions, state) {
  for (const [key, , , , , unit, scale = 1] of definitions) {
    const value = state[key] * scale;
    const text = Number(value.toFixed(2)) + unit;
    $('field-' + key).value = value;
    $('field-' + key).setAttribute('aria-valuetext', text);
    $('value-' + key).textContent = text;
  }
}

function selectedMarket() {
  return scenarios[selected].market;
}
function keepBreakRangeOrdered(key) {
  const market = selectedMarket();
  if (market.minBreakDrop <= market.maxBreakDrop) return;
  if (key === 'minBreakDrop') market.maxBreakDrop = market.minBreakDrop;
  else market.minBreakDrop = market.maxBreakDrop;
}
addFields($('market-fields'), marketFields, selectedMarket, keepBreakRangeOrdered);
addFields($('trade-primary'), primaryFields, () => trade);
addFields($('trade-fields'), tradeFields, () => trade);
addFields($('margin-fields'), marginFields, () => trade);
addFields($('call-sliders'), callFields, () => trade);
addFields($('manual-iv'), ivFields, () => manualCall, () => {
  trade.impliedVolatility = manualCall.impliedVolatility;
});
for (const definitions of [primaryFields, tradeFields, marginFields, callFields]) syncFields(definitions, trade);
syncFields(ivFields, manualCall);

function selectScenario(index) {
  selected = index;
  syncFields(marketFields, selectedMarket());
  requestRender();
}

const scenarioButtons = [];
const tableButtons = [];
const tableRows = [];
for (const [index, scenario] of scenarios.entries()) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scenario';
  button.innerHTML = '<span class="selection-dot" aria-hidden="true"></span><span><strong></strong><small></small></span>';
  button.addEventListener('click', () => selectScenario(index));
  scenarioButtons.push(button);
  $('scenarios').append(button);

  const row = document.createElement('tr');
  row.innerHTML = '<th scope="row"><button class="table-button" type="button"></button></th><td></td><td></td><td></td>';
  const rowButton = row.querySelector('button');
  rowButton.addEventListener('click', () => selectScenario(index));
  tableRows.push(row);
  tableButtons.push(rowButton);
  $('comparison').append(row);

  const label = document.createElement('label');
  label.textContent = scenario.name;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = 0;
  input.max = 100;
  input.step = 1;
  input.value = weights[index];
  input.addEventListener('input', () => {
    weights[index] = input.value === '' || !input.validity.valid ? NaN : Number(input.value);
    requestRender();
  });
  label.append(input);
  $('weights').append(label);
}

$('reset-scenario').addEventListener('click', () => {
  scenarios[selected].market = { ...PRESETS[selected].market };
  selectScenario(selected);
});
for (const [id, label] of Object.entries(INSTRUMENTS)) $('instrument').add(new Option(label, id));
$('instrument').value = trade.instrument;
$('instrument').addEventListener('change', () => {
  trade.instrument = $('instrument').value;
  requestRender();
});
$('timing-metric').addEventListener('change', requestRender);
$('mix-panel').addEventListener('toggle', requestRender);
$('zoom-calls').addEventListener('change', requestRender);
$('iv-mode').addEventListener('change', () => {
  trade.impliedVolatility = $('iv-mode').value === 'manual' ? manualCall.impliedVolatility : null;
  requestRender();
});

function isCustomized(index) {
  const { market } = scenarios[index];
  return Object.keys(market).some(key => Math.abs(market[key] - PRESETS[index].market[key]) > 1e-12);
}

function displayScenario(index) {
  return scenarios[index].name + (isCustomized(index) ? ' (edited)' : '');
}

function calculate() {
  const { day, allocation, ...simulationSettings } = trade;
  const settingsKey = JSON.stringify(simulationSettings);
  if (settingsKey !== cache.key) {
    cache = { key: settingsKey, ages: new Map(), comparisons: new Map() };
  }

  const comparisons = scenarios.map(({ id, market }) => {
    const key = JSON.stringify([id, market, day]);
    if (!cache.comparisons.has(key)) {
      if (cache.comparisons.size >= 48) cache.comparisons.clear();
      const samples = simulate(market, trade, shocks, Object.keys(INSTRUMENTS));
      cache.comparisons.set(key, {
        samples,
        summaries: Object.fromEntries(Object.entries(samples).map(([name, sample]) => [name, summarize(sample)])),
      });
    }
    return cache.comparisons.get(key);
  });

  const market = selectedMarket();
  const timingKey = JSON.stringify(market);
  if (!cache.ages.has(timingKey)) {
    if (cache.ages.size >= 12) cache.ages.clear();
    const ages = Array.from({ length: LAST_ENTRY_DAY + 1 }, (_, age) => {
      if (age === day) return comparisons[selected].summaries[trade.instrument];
      const result = simulate(market, { ...trade, day: age }, shocks);
      return summarize(result[trade.instrument]);
    });
    cache.ages.set(timingKey, ages);
  }
  return { comparisons, ages: cache.ages.get(timingKey) };
}

function requestRender() {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(render);
}

function setCell(cell, display, value) {
  cell.textContent = display;
  cell.className = value < 0 ? 'negative' : value > 0 ? 'positive' : '';
}

function render() {
  frame = 0;
  const { comparisons, ages } = calculate();
  const instrument = INSTRUMENTS[trade.instrument];
  const scenarioName = displayScenario(selected);
  const scenario = comparisons[selected];
  const sample = scenario.samples[trade.instrument];
  const stats = scenario.summaries[trade.instrument];
  const market = selectedMarket();
  const isCall = trade.instrument === 'call';
  const entryIV = entryImpliedVolatility(market, trade);
  const zoom = Boolean(isCall && stats && $('zoom-calls').checked);

  scenarios.forEach(({ description }, index) => {
    const active = index === selected;
    const label = displayScenario(index);
    const button = scenarioButtons[index];
    button.setAttribute('aria-pressed', active);
    button.querySelector('strong').textContent = label;
    button.querySelector('small').textContent = isCustomized(index) ? 'Uses your edited market assumptions.' : description;
    tableButtons[index].textContent = label;
    tableButtons[index].setAttribute('aria-pressed', active);
    const row = tableRows[index];
    row.classList.toggle('active', active);
    const summary = comparisons[index].summaries[trade.instrument];
    setCell(row.cells[1], summary ? pct(summary.median, true) : 'Unavailable', summary?.median);
    row.cells[2].textContent = summary ? odds(summary.loss) : '–';
    setCell(row.cells[3], summary ? points(summary.p5 * trade.allocation) : '–', summary?.p5);
  });

  $('reset-scenario').disabled = !isCustomized(selected);
  const assumptions = marketAtAge(market, trade.day);
  $('age-preview').textContent = 'At day ' + trade.day + ', the assumed daily gain before a break is ' +
    pct(assumptions.drift, true) + ' and the chance of a break that day is ' + pct(assumptions.breakRisk) + '.';
  $('margin-fields').hidden = trade.instrument !== 'margin';
  $('call-fields').hidden = !isCall;
  $('manual-iv').hidden = trade.impliedVolatility === null;
  $('entry-iv').textContent = displayScenario(selected) + ' · ' + pct(entryIV) + ' annual entry IV';

  $('trade-context').textContent = instrument + ' · Entry day ' + trade.day +
    ' · Up to ' + trade.hold + ' days · ' + pct(trade.allocation) + ' allocation';
  $('distribution-context').textContent = scenarioName + ' · ' + instrument + ' · Entry day ' + trade.day;
  $('metrics').innerHTML = stats ? [
    ['Median trade', pct(stats.median, true)],
    ['Average trade', pct(stats.mean, true)],
    ['Chance of loss', odds(stats.loss)],
    ['5th percentile', pct(stats.p5, true)],
  ].map(([label, value]) => '<div class="metric"><small>' + label + '</small><strong>' + value + '</strong></div>').join('') : '';
  $('zoom-control').hidden = !isCall || !stats;
  $('zoom-note').hidden = !zoom;
  if (zoom) {
    const hiddenPaths = sample.returns.reduce((count, value) => count + Number(value < -0.8), 0);
    $('zoom-note').textContent = 'This view omits ' + odds(hiddenPaths / sample.returns.length) +
      ' of trades with returns below −80%. Bar heights use all paths as the denominator.';
  }
  for (const id of ['histogram', 'histogram-legend', 'timing-chart', 'sampling-note']) $(id).hidden = !stats;
  if (stats) {
    const tailLabels = [
      '95th percentile ' + pct(stats.p95, true),
      'Loss >50% ' + odds(stats.largeLoss),
      'Loss ≥80% ' + odds(stats.severeLoss),
    ];
    if (trade.instrument !== 'cash') tailLabels.push('Exit penalty applied ' + odds(stats.penalized));
    if (trade.instrument === 'margin') tailLabels.push('Liquidated ' + odds(stats.liquidated));
    if (isCall) tailLabels.push('Expired worthless ' + odds(stats.expiredWorthless));
    $('tail-notes').textContent = tailLabels.join(' · ') + '. Rightmost bin groups returns at or above +300%.';
  } else {
    $('tail-notes').textContent = 'The call has a zero modeled entry premium. Set a positive fixed implied volatility in Call settings to see its return.';
  }

  const timingMetric = $('timing-metric').value;
  const median = timingMetric === 'median';
  $('timing-label').textContent = median ? 'Median trade return' : 'Chance of losing money';
  $('timing-note').textContent = stats
    ? 'Day ' + trade.day + ' · ' + (median ? pct(stats.median, true) + ' median trade return' :
      odds(stats.loss) + ' chance of loss') + ' if the rally is active at entry.'
    : 'Set a positive fixed implied volatility to compare call returns by entry day.';
  const survival = Array.from({ length: LAST_ENTRY_DAY + 1 }, (_, age) => survivalAtAge(market, age));
  $('survival-note').textContent = survival[trade.day] === 0
    ? 'This scenario gives rallies zero chance of reaching day ' + trade.day + ' without a break. Trade results assume a hypothetical active rally.'
    : odds(survival[trade.day]) + ' of rallies reach day ' + trade.day + ' without a sharp break under these assumptions.';
  $('instrument-context').textContent = scenarioName + ' · Same underlying price paths for each position';
  $('instrument-comparison').innerHTML = Object.entries(INSTRUMENTS).map(([id, label]) => {
    const result = scenario.summaries[id];
    if (!result) return '<tr><th scope="row">' + label + '</th><td colspan="3">Zero entry premium</td></tr>';
    return '<tr' + (id === trade.instrument ? ' class="active"' : '') + '><th scope="row">' + label +
      '</th><td>' + pct(result.median, true) + '</td><td>' + odds(result.loss) +
      '</td><td>' + pct(result.p5, true) + '</td></tr>';
  }).join('');
  $('instrument-notes').textContent = format(trade.leverage, '×') + ' margin with ' + pct(trade.maintenance) +
    ' maintenance equity. Calls expire after ' + trade.callMaturity + ' trading days with a ' + pct(trade.strike) +
    ' strike and ' + pct(entryIV) + ' annual entry IV. Select an instrument to edit its settings.';

  charts = {
    histogram: stats ? { ...stats, returns: sample.returns, masses: null } : null,
    timing: stats ? ages.map(summary => summary[timingMetric]) : null,
    survival,
    median,
    zoom,
  };
  renderBlend(comparisons.map(result => result.samples[trade.instrument]));
  drawCharts();
}

function renderBlend(samples) {
  if (!$('mix-panel').open) return;
  const sum = weights.reduce((total, weight) => total + weight, 0);
  $('weight-status').textContent = Number.isNaN(sum)
    ? 'Enter a whole number from 0 to 100 for each scenario.'
    : sum === 100 ? 'Weights total 100%.' : 'Weights total ' + sum + '%. Adjust them to total 100%.';
  const blend = sum === 100 ? mixSamples(samples, weights) : null;
  $('mix-chart').hidden = !blend;
  $('mix-stats').textContent = blend
    ? 'Median ' + pct(blend.median, true) + ' · Loss chance ' + odds(blend.loss) +
      ' · Portfolio P5 ' + points(blend.p5 * trade.allocation) +
      (trade.instrument === 'call' ? ' · Expired worthless ' + odds(blend.expiredWorthless) : '')
    : sum === 100 ? 'Give unavailable call scenarios zero weight or set a positive fixed implied volatility.' : '';
  charts.blend = blend;
}

const styles = getComputedStyle(document.documentElement);
const color = name => styles.getPropertyValue('--' + name).trim();
const palette = Object.fromEntries(
  ['line', 'muted', 'text', 'accent', 'plot-loss', 'plot-gain', 'plot-mean'].map(name => [name, color(name)]),
);

function chartContext(canvas) {
  const { width, height } = canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineJoin = 'round';
  return { ctx, width, height };
}

function stroke(ctx, x1, y1, x2, y2, strokeColor, dash = []) {
  ctx.strokeStyle = strokeColor;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHistogram(id, sample, zoom = false) {
  const canvas = $(id);
  const chart = chartContext(canvas);
  if (!chart) return;
  const { ctx, width, height } = chart;
  const top = 11;
  const bottom = height - 23;
  const left = 43;
  const right = width - 13;
  const lower = zoom ? -0.8 : trade.instrument === 'margin' ? -Math.ceil(trade.leverage) : -1;
  const upper = 3;
  const step = 0.2;
  const binCount = Math.round((upper - lower) / step) + 1;
  const bins = new Float64Array(binCount);
  const binWidth = (right - left) / binCount;
  const x = value => left + Math.max(0, Math.min(binCount - 0.5, (value - lower) / step)) * binWidth;
  for (let i = 0; i < sample.returns.length; i++) {
    if (zoom && sample.returns[i] < lower) continue;
    const index = Math.max(0, Math.min(binCount - 1, Math.floor((sample.returns[i] - lower) / step + 1e-10)));
    bins[index] += sample.masses ? sample.masses[i] : 1 / sample.returns.length;
  }

  const max = Math.max(0.05, Math.ceil((Math.max(...bins) - 1e-10) * 20) / 20);
  const y = share => bottom - share / max * (bottom - top);
  ctx.textAlign = 'right';
  ctx.fillStyle = palette.muted;
  for (const level of [0, max / 2, max]) {
    stroke(ctx, left, y(level), right, y(level), palette.line);
    ctx.fillText(pct(level), left - 7, y(level) + 4);
  }
  for (let i = 0; i < bins.length; i++) {
    ctx.fillStyle = lower + i * step < -1e-8 ? palette['plot-loss'] : palette['plot-gain'];
    ctx.fillRect(left + i * binWidth + 1, y(bins[i]), Math.max(1, binWidth - 2), bottom - y(bins[i]));
  }

  stroke(ctx, x(0), top, x(0), bottom, palette.muted);
  if (!zoom || sample.median >= lower) stroke(ctx, x(sample.median), top, x(sample.median), bottom, palette.text, [5, 4]);
  if (!zoom || sample.mean >= lower) stroke(ctx, x(sample.mean), top, x(sample.mean), bottom, palette['plot-mean'], [2, 4]);
  ctx.textAlign = 'center';
  ctx.fillStyle = palette.muted;
  for (const tick of [lower, 0, 1, 2, 3]) {
    if (width < 420 && tick === 2) continue;
    ctx.fillText(pct(tick, true), Math.min(right - 9, x(tick)), height - 5);
  }
  canvas.setAttribute('aria-label', (zoom ? 'Return histogram from minus 80 percent onward. ' : 'Return histogram. ') +
    'The median is ' + pct(sample.median, true) + ', the mean is ' + pct(sample.mean, true) +
    ', and ' + odds(sample.loss) + ' of trades lose money.');
}

function drawAgeLine(id, series, probability) {
  const canvas = $(id);
  const chart = chartContext(canvas);
  if (!chart) return;
  const { ctx, width, height } = chart;
  const left = 42;
  const right = width - 15;
  const top = 11;
  const bottom = height - 22;
  const min = probability ? 0 : Math.min(0, Math.floor(Math.min(...series) * 10) / 10);
  const max = probability ? 1 : Math.max(0.1, Math.ceil(Math.max(...series) * 10) / 10);
  const x = day => left + day / LAST_ENTRY_DAY * (right - left);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);
  ctx.fillStyle = palette.muted;
  ctx.textAlign = 'right';
  for (const level of [min, (min + max) / 2, max]) {
    stroke(ctx, left, y(level), right, y(level), palette.line);
    ctx.fillText(pct(level, !probability), left - 6, y(level) + 4);
  }
  ctx.textAlign = 'center';
  for (const day of [0, 5, 10, 15]) ctx.fillText(day + 'd', x(day), height - 5);

  stroke(ctx, x(trade.day), top, x(trade.day), bottom, palette.line, [3, 3]);
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2.25;
  ctx.beginPath();
  ctx.moveTo(x(0), y(series[0]));
  for (let day = 1; day < series.length; day++) ctx.lineTo(x(day), y(series[day]));
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = palette.accent;
  ctx.arc(x(trade.day), y(series[trade.day]), 4, 0, 2 * Math.PI);
  ctx.fill();

  const measure = id === 'survival-chart' ? 'Share without a break' : probability ? 'Chance of loss' : 'Median return';
  canvas.setAttribute('aria-label', measure + ' by entry day. ' +
    series.map((value, day) => 'Day ' + day + ', ' + (probability ? odds(value) : pct(value, true))).join('. ') + '.');
}

function drawCharts() {
  if (!charts.survival) return;
  if (charts.histogram) drawHistogram('histogram', charts.histogram, charts.zoom);
  if (charts.timing) drawAgeLine('timing-chart', charts.timing, !charts.median);
  drawAgeLine('survival-chart', charts.survival, true);
  if (charts.blend && $('mix-panel').open) drawHistogram('mix-chart', charts.blend);
}

const observer = new ResizeObserver(() => {
  if (chartFrame) cancelAnimationFrame(chartFrame);
  chartFrame = requestAnimationFrame(drawCharts);
});
for (const id of ['histogram', 'timing-chart', 'survival-chart', 'mix-chart']) observer.observe($(id));

syncFields(marketFields, selectedMarket());
render();
