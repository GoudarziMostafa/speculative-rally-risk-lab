import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TRADE, PRESETS, TRADING_DAYS, callValue, createShocks, entryImpliedVolatility, marketAtAge, mixSamples,
  simulate, summarize, survivalAtAge,
} from '../dist/model.mjs';

const shocks = createShocks();
const fixedHorizon = { ...DEFAULT_TRADE, takeProfit: 0, trailingStop: 0, cost: 0, callFee: 0, penaltyChance: 0 };
const neutral = {
  ...PRESETS[0].market,
  buyingStrength: 0,
  initialBreakRisk: 0,
  breakRiskSlope: 0,
};

function assertNear(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

function onePath() {
  const path = createShocks(1);
  path.normal.fill(0);
  path.breaks.fill(0.9);
  path.severity.fill(0);
  path.fills.fill(0.9);
  return path;
}

test('identical scenarios and identical shocks produce identical instrument results', () => {
  const market = PRESETS[0].market;
  const instruments = ['shares', 'margin', 'call', 'cash'];
  const result = simulate(market, DEFAULT_TRADE, shocks, instruments);
  assert.deepEqual(result, simulate({ ...market }, DEFAULT_TRADE, createShocks(), instruments));
  assert.deepEqual(result.shares, simulate(market, DEFAULT_TRADE, shocks).shares);
  assert.equal(summarize(result.cash).loss, 0);
});

test('the entry-day chart is exactly flat with age effects removed', () => {
  const market = { ...PRESETS[0].market, pressureDays: 45, breakRiskSlope: 0 };
  const first = simulate(market, { ...DEFAULT_TRADE, day: 0 }, shocks).shares;
  for (let day = 1; day <= 15; day++) {
    assert.deepEqual(simulate(market, { ...DEFAULT_TRADE, day }, shocks).shares, first);
  }
});

test('allocation scales portfolio impact and leaves trade-level results identical', () => {
  const market = PRESETS[0].market;
  const low = simulate(market, { ...DEFAULT_TRADE, allocation: 0.05 }, shocks).shares;
  const high = simulate(market, { ...DEFAULT_TRADE, allocation: 0.10 }, shocks).shares;
  assert.deepEqual(low, high);
  assert.equal(summarize(low).p5 * 0.05 * 2, summarize(high).p5 * 0.10);
});

test('zero expected daily simple return produces a mean near zero at a fixed horizon', () => {
  const sample = simulate(neutral, fixedHorizon, shocks).shares;
  const standardError = Math.sqrt(Math.expm1(neutral.volatility ** 2 * fixedHorizon.hold) / shocks.paths);
  assertNear(summarize(sample).mean, 0, 4 * standardError);
});

test('model advances age during the trade and computes survival to the start of entry day', () => {
  const market = { ...neutral, volatility: 0, buyingStrength: 0.1, pressureDays: 0, fadeDays: 2 };
  const trade = { ...fixedHorizon, day: 0, hold: 2 };
  assertNear(simulate(market, trade, onePath()).shares.returns[0], 1.10 * 1.05 - 1);

  const fragile = { ...market, initialBreakRisk: 0.1, breakRiskSlope: 0.1, minBreakDrop: 0.3, maxBreakDrop: 0.3 };
  assert.equal(survivalAtAge(fragile, 0), 1);
  assertNear(survivalAtAge(fragile, 2), 0.9 * 0.8);
  assertNear(marketAtAge(fragile, 2).breakRisk, 0.3);
  assert.equal(marketAtAge(fragile, 15).breakRisk, 1);
  const path = onePath();
  path.breaks[1] = 0.15;
  assertNear(simulate(fragile, trade, path).shares.returns[0], 1.10 * 1.05 * 0.7 - 1);
});

test('variable break severity affects gap liquidation at the first daily mark', () => {
  const market = { ...neutral, volatility: 0, initialBreakRisk: 1, minBreakDrop: 0.40, maxBreakDrop: 0.80 };
  const trade = { ...fixedHorizon, instrument: 'margin', leverage: 2, marginRate: 0 };
  const path = onePath();
  const mild = simulate(market, trade, path).margin;
  path.severity[0] = 0.75;
  const severe = simulate(market, trade, path).margin;
  assert.equal(severe.liquidations[0], 1);
  assert.equal(severe.exits[0], 1);
  assertNear(mild.returns[0], -0.8);
  assertNear(severe.returns[0], -1.4);
});

test('calls retain time value on early exits and settle at intrinsic value on expiry', () => {
  const market = { ...neutral, volatility: 0 };
  const early = { ...fixedHorizon, instrument: 'call', hold: 5, impliedVolatility: 1.5 };
  const benchmarkPremium = callValue(1, early.strike, early.callMaturity, early.impliedVolatility);
  const expectedProceeds = callValue(1, early.strike, 5, early.impliedVolatility);
  assert.ok(expectedProceeds > 0 && expectedProceeds < benchmarkPremium);
  assertNear(simulate(market, early, onePath()).call.returns[0], expectedProceeds / benchmarkPremium - 1);

  const expiry = { ...early, hold: 15 };
  const inTheMoney = { ...market, buyingStrength: 0.03, pressureDays: 30 };
  const result = simulate(inTheMoney, expiry, onePath()).call;
  assert.equal(result.exits[0], expiry.callMaturity);
  assertNear(result.returns[0], (1.03 ** 10 - expiry.strike) / benchmarkPremium - 1);
  assert.equal(summarize(simulate(market, expiry, onePath()).call).expiredWorthless, 1);
  assert.equal(summarize(simulate(market, early, onePath()).call).expiredWorthless, 0);
});

test('volatility-matched calls average near zero in the frictionless zero-drift benchmark', () => {
  const trade = { ...fixedHorizon, instrument: 'call', hold: fixedHorizon.callMaturity };
  const expectedIv = neutral.volatility * Math.sqrt(TRADING_DAYS);
  assert.equal(entryImpliedVolatility(neutral, trade), expectedIv);
  assert.deepEqual(
    simulate(neutral, trade, shocks),
    simulate(neutral, { ...trade, impliedVolatility: expectedIv }, shocks),
  );
  const sample = simulate(neutral, trade, shocks).call;
  const { mean } = summarize(sample);
  const sumOfSquares = sample.returns.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const standardError = Math.sqrt(sumOfSquares / (shocks.paths - 1) / shocks.paths);
  assertNear(mean, 0, 3 * standardError);
  assert.equal(simulate({ ...neutral, volatility: 0 }, trade, shocks).call, null);
});

test('post-break implied volatility and call fees affect call marks without affecting stock exits', () => {
  const market = { ...neutral, volatility: 0, initialBreakRisk: 1, minBreakDrop: 0.2, maxBreakDrop: 0.2 };
  const trade = { ...fixedHorizon, instrument: 'call', hold: 1, impliedVolatility: 2 };
  const instruments = ['shares', 'call'];
  const base = simulate(market, trade, onePath(), instruments);
  const stressed = simulate(market, { ...trade, postBreakIvMultiplier: 0.5, callFee: 0.1 }, onePath(), instruments);
  const premium = callValue(1, trade.strike, trade.callMaturity, 2);
  const proceeds = callValue(0.8, trade.strike, trade.callMaturity - 1, 1);
  assertNear(stressed.call.returns[0], proceeds * 0.95 / (premium * 1.05) - 1);
  assert.ok(stressed.call.returns[0] < base.call.returns[0]);
  assert.deepEqual(stressed.shares, base.shares);
  const expiry = { ...trade, hold: trade.callMaturity };
  assert.deepEqual(
    simulate(market, expiry, onePath()),
    simulate(market, { ...expiry, postBreakIvMultiplier: 2 }, onePath()),
  );
});

test('loss thresholds count exactly 80% as severe and exclude losses just below it', () => {
  const returns = Float64Array.from([-0.8, -0.79, -0.5, 0]);
  const empty = new Uint8Array(returns.length);
  const stats = summarize({ returns, liquidations: empty, penalized: empty });
  assert.equal(stats.largeLoss, 0.5);
  assert.equal(stats.severeLoss, 0.25);
  assert.equal(stats.liquidated, 0);
});

test('scenario weights blend individual outcomes and reproduce a 100% scenario exactly', () => {
  const samples = PRESETS.map(({ market }) => simulate(market, DEFAULT_TRADE, shocks).shares);
  const blend = mixSamples(samples, [0, 100, 0]);
  assert.deepEqual(blend, { ...summarize(samples[1]), returns: samples[1].returns, masses: null });
  const weighted = mixSamples(samples, [40, 30, 30]);
  const mass = weighted.masses.reduce((sum, weight) => sum + weight, 0);
  assertNear(mass, 1, 1e-10);
  assertNear(weighted.loss, 0.4 * summarize(samples[0]).loss +
    0.3 * summarize(samples[1]).loss + 0.3 * summarize(samples[2]).loss);
  assert.ok(weighted.returns.some(value => value === weighted.p5));
  assert.equal(mixSamples(samples, [0, 0, 0]), null);
  assert.equal(mixSamples([null, samples[1], samples[2]], [40, 30, 30]), null);
  assert.deepEqual(mixSamples([null, samples[1], null], [0, 100, 0]), blend);
});
