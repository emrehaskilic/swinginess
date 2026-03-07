import { describe, it, expect, beforeEach } from 'vitest';
import { DryRunSessionService } from '../dryrun/DryRunSessionService';
import { DryRunConfig } from '../dryrun/types';

describe('DryRun sizing logic', () => {
  let service: any;

  beforeEach(() => {
    service = new DryRunSessionService({} as any);
    service.runId = 'test-id';
  });

  const createConfig = (sizing: any = {}): DryRunConfig => ({
    runId: 'test-id',
    walletBalanceStartUsdt: 1000,
    initialMarginUsdt: 500,
    leverage: 33,
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0006,
    maintenanceMarginRate: 0.005,
    fundingRate: 0,
    fundingIntervalMs: 28_800_000,
    proxy: { mode: 'backend-proxy', restBaseUrl: '', marketWsBaseUrl: '' },
    sizing,
  });

  const createSession = (posQty = 0, price = 10, addsUsed = 0) => ({
    dynamicLeverage: 33,
    capital: {
      effectiveReserveUsdt: 1000,
      initialMarginUsdt: 500,
      effectiveInitialMarginUsdt: 500,
    },
    lastState: {
      position: posQty > 0 ? { qty: posQty } : null,
    },
    addOnState: { count: addsUsed },
  });

  it('ENTRY uses the full seed notional budget', () => {
    service.config = createConfig({});
    const session = createSession(0, 10, 0);
    const res = service.computeRiskSizing(session, 10, 'TREND', 1, { mode: 'ENTRY' });
    expect(res.qty).toBe(1650);
  });

  it('ADD1 uses 35% of the seed notional budget', () => {
    service.config = createConfig({});
    const session = createSession(1650, 10, 0);
    const res = service.computeRiskSizing(session, 10, 'TREND', 1, { mode: 'ADD' });
    expect(res.qty).toBe(577.5);
  });

  it('ADD2 uses 25% of the seed notional budget', () => {
    service.config = createConfig({});
    const session = createSession(2227.5, 10, 1);
    const res = service.computeRiskSizing(session, 10, 'TREND', 1, { mode: 'ADD' });
    expect(res.qty).toBe(412.5);
  });

  it('ADD3 is vetoed after the configured two add-ons', () => {
    service.config = createConfig({});
    const session = createSession(2640, 10, 2);
    const res = service.computeRiskSizing(session, 10, 'TREND', 1, { mode: 'ADD' });
    expect(res.qty).toBe(0);
  });

  it('maxPositionNotional clips the remaining add budget', () => {
    service.config = createConfig({ maxPositionNotional: 18_000 });
    const session = createSession(1650, 10, 0);
    const res = service.computeRiskSizing(session, 10, 'TREND', 1, { mode: 'ADD' });
    expect(res.qty).toBe(150);
  });
});
