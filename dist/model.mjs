export const PATH_COUNT = 4000;
export const SEED = 42;
export const MAX_HOLD = 30;
export const LAST_ENTRY_DAY = 15;
export const TRADING_DAYS = 252;
export const INSTRUMENTS = {
  shares: 'Shares',
  margin: 'Shares on margin',
  call: 'Short-dated call',
  cash: 'Stay out',
};

const common = {
  buyingStrength: 0.045,
  volatility: 0.13,
  initialBreakRisk: 0.035,
  breakRiskSlope: 0,
  minBreakDrop: 0.18,
  maxBreakDrop: 0.48,
  postBreakDrift: -0.02,
};

export const PRESETS = [
  {
    id: 'fades',
    name: 'Attention fades',
    description: 'Buying pressure tapers from the start. Break risk stays level.',
    market: { ...common, pressureDays: 0, fadeDays: 12 },
  },
  {
    id: 'persists',
    name: 'Buying persists',
    description: 'Buying pressure holds for 15 days before it starts to fade.',
    market: { ...common, pressureDays: 15, fadeDays: 6 },
  },
  {
    id: 'fragile',
    name: 'Fragile rally',
    description: 'Buying pressure holds, but the chance of a sharp break rises each day.',
    market: { ...common, pressureDays: 15, fadeDays: 6, breakRiskSlope: 0.009 },
  },
];

export const DEFAULT_TRADE = {
  day: 8,
  instrument: 'shares',
  allocation: 0.05,
  hold: 10,
  takeProfit: 1,
  trailingStop: 0.30,
  cost: 0.01,
  penaltyChance: 0.30,
  exitPenalty: 0.05,
  leverage: 2,
  maintenance: 0.25,
  marginRate: 0.08,
  callMaturity: 10,
  strike: 1.20,
  impliedVolatility: null,
  postBreakIvMultiplier: 1,
  callFee: 0.01,
};

export function entryImpliedVolatility(market, trade) {
  return trade.impliedVolatility ?? market.volatility * Math.sqrt(TRADING_DAYS);
}

export function marketAtAge(market, age) {
  const elapsedAfterPlateau = Math.max(0, age - market.pressureDays);
  const pressure = market.fadeDays > 0
    ? Math.max(0, 1 - elapsedAfterPlateau / market.fadeDays)
    : Number(age < market.pressureDays);
  return {
    drift: market.buyingStrength * pressure,
    breakRisk: Math.min(1, market.initialBreakRisk + age * market.breakRiskSlope),
  };
}

export function survivalAtAge(market, age) {
  let survival = 1;
  for (let day = 0; day < age; day++) {
    survival *= 1 - marketAtAge(market, day).breakRisk;
  }
  return survival;
}

export function createShocks(paths = PATH_COUNT, seed = SEED) {
  let state = seed >>> 0;
  function uniform() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  const length = paths * MAX_HOLD;
  const normal = new Float64Array(length);
  const breaks = new Float64Array(length);
  const severity = new Float64Array(length);
  const fills = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    normal[index] = Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
    breaks[index] = uniform();
    severity[index] = uniform();
    fills[index] = uniform();
  }
  return { paths, normal, breaks, severity, fills };
}

function normalCdf(x) {
  if (x === 0) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - tail : tail;
}

// Black–Scholes benchmark with zero rates and dividends.
export function callValue(spot, strike, remainingDays, annualVolatility) {
  const intrinsic = Math.max(spot - strike, 0);
  if (remainingDays <= 0 || annualVolatility === 0 || spot === 0) return intrinsic;
  const scale = annualVolatility * Math.sqrt(remainingDays / TRADING_DAYS);
  const d1 = Math.log(spot / strike) / scale + scale / 2;
  const d2 = d1 - scale;
  return Math.max(intrinsic, spot * normalCdf(d1) - strike * normalCdf(d2));
}

export function simulate(market, trade, shocks, instruments = [trade.instrument]) {
  const results = Object.fromEntries(instruments.map(instrument => [instrument, {
    returns: new Float64Array(shocks.paths),
    exits: new Uint8Array(shocks.paths),
    liquidations: new Uint8Array(shocks.paths),
    penalized: new Uint8Array(shocks.paths),
  }]));
  const entryIV = entryImpliedVolatility(market, trade);
  const callPremium = results.call ? callValue(1, trade.strike, trade.callMaturity, entryIV) : 0;
  if (results.call) {
    if (callPremium > 0) results.call.expiredWorthless = new Uint8Array(shocks.paths);
    else results.call = null;
  }
  const { shares, margin, call } = results;
  const horizon = shares || margin ? trade.hold : Math.min(trade.hold, trade.callMaturity);
  const schedule = Array.from({ length: horizon }, (_, day) => marketAtAge(market, trade.day + day));
  const halfCost = trade.cost / 2;
  const varianceAdjustment = market.volatility ** 2 / 2;
  const decliningDrift = Math.log1p(market.postBreakDrift) - varianceAdjustment;
  const activeDrift = schedule.map(day => Math.log1p(day.drift) - varianceAdjustment);
  const initialDebt = 1 - 1 / trade.leverage;
  const debt = schedule.map((_, day) => initialDebt * (1 + trade.marginRate * (day + 1) / TRADING_DAYS));
  const halfCallFee = (trade.callFee ?? trade.cost) / 2;
  const breakIV = entryIV * (trade.postBreakIvMultiplier ?? 1);

  for (let path = 0; path < shocks.paths; path++) {
    let price = 1;
    let peak = 1;
    let broken = false;
    let sharesOpen = Boolean(shares);
    let marginOpen = Boolean(margin);
    let callOpen = Boolean(call);

    for (let day = 0; day < horizon && (sharesOpen || marginOpen || callOpen); day++) {
      const index = path * MAX_HOLD + day;
      const previousPrice = price;
      const drift = broken ? decliningDrift : activeDrift[day];
      price *= Math.exp(drift + market.volatility * shocks.normal[index]);
      if (!broken && shocks.breaks[index] < schedule[day].breakRisk) {
        price *= 1 - (market.minBreakDrop + (market.maxBreakDrop - market.minBreakDrop) * shocks.severity[index]);
        broken = true;
      }

      peak = Math.max(peak, price);
      const tradeDay = day + 1;
      const exitSignal = tradeDay === trade.hold ||
        (trade.takeProfit > 0 && price >= 1 + trade.takeProfit) ||
        (trade.trailingStop > 0 && price <= peak * (1 - trade.trailingStop));
      const penalty = trade.exitPenalty > 0 && Math.abs(price / previousPrice - 1) >= 0.25 &&
        shocks.fills[index] < trade.penaltyChance;
      const exitPriceFactor = penalty ? 1 - trade.exitPenalty : 1;
      const fillFactor = exitPriceFactor * (1 - halfCost);

      if (sharesOpen && exitSignal) {
        shares.returns[path] = price * fillFactor / (1 + halfCost) - 1;
        shares.exits[path] = tradeDay;
        shares.penalized[path] = penalty;
        sharesOpen = false;
      }
      const liquidated = marginOpen && initialDebt > 0 && (price - debt[day]) / price <= trade.maintenance;
      if (marginOpen && (exitSignal || liquidated)) {
        margin.returns[path] = (price * fillFactor - debt[day]) / (1 - initialDebt + halfCost) - 1;
        margin.exits[path] = tradeDay;
        margin.liquidations[path] = liquidated;
        margin.penalized[path] = penalty;
        marginOpen = false;
      }
      if (callOpen && (exitSignal || tradeDay === trade.callMaturity)) {
        const remaining = trade.callMaturity - tradeDay;
        const mark = callValue(price, trade.strike, remaining, broken ? breakIV : entryIV);
        const proceeds = remaining === 0 ? mark : mark * exitPriceFactor * (1 - halfCallFee);
        call.returns[path] = proceeds / (callPremium * (1 + halfCallFee)) - 1;
        call.exits[path] = tradeDay;
        call.penalized[path] = remaining > 0 && mark > 0 && penalty;
        call.expiredWorthless[path] = remaining === 0 && mark === 0;
        callOpen = false;
      }
    }
  }
  return results;
}

export function empiricalQuantile(sorted, probability) {
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

export function summarize(sample) {
  if (!sample) return null;
  const { returns, liquidations, penalized, expiredWorthless } = sample;
  const sorted = returns.slice().sort();
  let sum = 0;
  let losses = 0;
  let largeLosses = 0;
  let severeLosses = 0;
  let liquidationCount = 0;
  let penaltyCount = 0;
  let worthlessCount = 0;
  for (let i = 0; i < returns.length; i++) {
    const value = returns[i];
    sum += value;
    losses += Number(value < 0);
    largeLosses += Number(value < -0.5);
    severeLosses += Number(value <= -0.8);
    liquidationCount += liquidations[i];
    penaltyCount += penalized[i];
    if (expiredWorthless) worthlessCount += expiredWorthless[i];
  }
  return {
    mean: sum / returns.length,
    median: empiricalQuantile(sorted, 0.5),
    p5: empiricalQuantile(sorted, 0.05),
    p95: empiricalQuantile(sorted, 0.95),
    loss: losses / returns.length,
    largeLoss: largeLosses / returns.length,
    severeLoss: severeLosses / returns.length,
    liquidated: liquidationCount / returns.length,
    penalized: penaltyCount / returns.length,
    expiredWorthless: worthlessCount / returns.length,
  };
}

export function mixSamples(samples, weights) {
  const active = weights.map((weight, index) => ({ weight, index })).filter(entry => entry.weight > 0);
  if (active.length === 0 || active.some(({ index }) => !samples[index])) return null;
  if (active.length === 1) {
    const sample = samples[active[0].index];
    return { ...summarize(sample), returns: sample.returns, masses: null };
  }

  const totalWeight = active.reduce((sum, entry) => sum + entry.weight, 0);
  const count = active.reduce((sum, entry) => sum + samples[entry.index].returns.length, 0);
  const returns = new Float64Array(count);
  const masses = new Float64Array(count);
  const metrics = { mean: 0, loss: 0, largeLoss: 0, severeLoss: 0, liquidated: 0, penalized: 0, expiredWorthless: 0 };
  let offset = 0;
  for (const { index, weight } of active) {
    const share = weight / totalWeight;
    const sample = samples[index];
    const stats = summarize(sample);
    returns.set(sample.returns, offset);
    masses.fill(share / sample.returns.length, offset, offset + sample.returns.length);
    for (const key of Object.keys(metrics)) metrics[key] += share * stats[key];
    offset += sample.returns.length;
  }
  const order = Array.from(returns.keys()).sort((left, right) => returns[left] - returns[right]);
  function quantile(probability) {
    let cumulative = 0;
    for (const index of order) {
      cumulative += masses[index];
      if (cumulative + 1e-12 >= probability) return returns[index];
    }
    return returns[order.at(-1)];
  }
  return { ...metrics, median: quantile(0.5), p5: quantile(0.05), p95: quantile(0.95), returns, masses };
}
