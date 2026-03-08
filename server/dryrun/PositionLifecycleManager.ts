import type { StrategySignal } from '../types/strategy';
import type { DryRunOrderflowMetrics } from './DryRunTradeLogger';
import type { DryRunStateSnapshot } from './types';

export type ActiveTrade = {
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
  entryPrice: number;
  qty: number;
  maxQtySeen: number;
  notional: number;
  marginUsed: number;
  maxMarginUsed: number;
  leverage: number;
  pnlRealized: number;
  feeAcc: number;
  fundingAcc: number;
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
};

export interface OpenTradeInput {
  tradeId: string;
  position: NonNullable<DryRunStateSnapshot['position']>;
  eventTimestampMs: number;
  openingFee: number;
  leverage: number;
  signalType: string | null;
  signalScore: number | null;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
}

export interface FallbackTradeInput {
  tradeId: string;
  side: 'LONG' | 'SHORT';
  entryTimeMs: number;
  entryPrice: number;
  qty: number;
  leverage: number;
  candidate: StrategySignal['candidate'] | null;
  orderflow: DryRunOrderflowMetrics;
}

export interface ExitTradeSnapshot {
  realized: number;
  feeUsdt: number;
  fundingUsdt: number;
  net: number;
  reportedQty: number;
  marginBase: number;
  returnPct: number | null;
  rMultiple: number | null;
}

export class PositionLifecycleManager {
  createActiveTrade(input: OpenTradeInput): ActiveTrade {
    const entryPrice = Number(input.position.entryPrice) || 0;
    const qty = Number(input.position.qty) || 0;
    const notional = entryPrice * qty;
    const marginUsed = input.leverage > 0 ? notional / input.leverage : 0;
    return {
      tradeId: input.tradeId,
      side: input.position.side,
      entryTimeMs: input.eventTimestampMs,
      entryPrice,
      qty,
      maxQtySeen: qty,
      notional,
      marginUsed,
      maxMarginUsed: marginUsed,
      leverage: input.leverage,
      pnlRealized: 0,
      feeAcc: input.openingFee,
      fundingAcc: 0,
      signalType: input.signalType,
      signalScore: input.signalScore,
      candidate: input.candidate,
      orderflow: input.orderflow,
    };
  }

  createFallbackTrade(input: FallbackTradeInput): ActiveTrade {
    const entryPrice = Number(input.entryPrice) || 0;
    const qty = Number(input.qty) || 0;
    const notional = entryPrice * qty;
    const marginUsed = input.leverage > 0 ? notional / input.leverage : 0;
    return {
      tradeId: input.tradeId,
      side: input.side,
      entryTimeMs: input.entryTimeMs,
      entryPrice,
      qty,
      maxQtySeen: qty,
      notional,
      marginUsed,
      maxMarginUsed: marginUsed,
      leverage: input.leverage,
      pnlRealized: 0,
      feeAcc: 0,
      fundingAcc: 0,
      signalType: null,
      signalScore: null,
      candidate: input.candidate,
      orderflow: input.orderflow,
    };
  }

  accumulateTrade(trade: ActiveTrade, realized: number, fee: number, funding: number): void {
    trade.pnlRealized += realized;
    trade.feeAcc += fee;
    trade.fundingAcc += funding;
  }

  syncTradePosition(
    trade: ActiveTrade,
    position: NonNullable<DryRunStateSnapshot['position']>,
    leverage: number,
  ): void {
    const entryPrice = Number(position.entryPrice) || trade.entryPrice;
    const qty = Number(position.qty) || trade.qty;
    const notional = entryPrice * qty;
    const marginUsed = leverage > 0 ? notional / leverage : trade.marginUsed;

    trade.side = position.side;
    trade.entryPrice = entryPrice;
    trade.qty = qty;
    trade.maxQtySeen = Math.max(Number(trade.maxQtySeen || 0), qty);
    trade.notional = notional;
    trade.marginUsed = marginUsed;
    trade.maxMarginUsed = Math.max(Number(trade.maxMarginUsed || 0), marginUsed);
    trade.leverage = leverage;
  }

  buildExitSnapshot(trade: ActiveTrade): ExitTradeSnapshot {
    const realized = trade.pnlRealized;
    const feeUsdt = trade.feeAcc;
    const fundingUsdt = trade.fundingAcc;
    const net = realized - feeUsdt + fundingUsdt;
    const reportedQty = Math.max(0, Number(trade.maxQtySeen || trade.qty || 0));
    const marginBase = Math.max(0, Number(trade.maxMarginUsed || trade.marginUsed || 0));
    const returnPct = marginBase > 0 ? (net / marginBase) * 100 : null;
    return {
      realized,
      feeUsdt,
      fundingUsdt,
      net,
      reportedQty,
      marginBase,
      returnPct,
      rMultiple: this.computeRMultiple(trade, net),
    };
  }

  resolveExitReason(input: {
    pendingExitReason: string | null;
    liquidation: boolean;
    realized: number;
    fallback: string | null;
  }): string {
    if (input.liquidation) return 'RISK_EMERGENCY';
    if (input.fallback) return input.fallback;
    if (input.pendingExitReason) return input.pendingExitReason;
    if (input.realized > 0) return 'PROFITLOCK_STOP';
    if (input.realized < 0) return 'RISK_EMERGENCY';
    return 'HARD_INVALIDATION';
  }

  computeRMultiple(trade: ActiveTrade, net: number): number | null {
    const sl = trade.candidate?.slPrice;
    const qty = Math.max(Number(trade.maxQtySeen || 0), Number(trade.qty || 0));
    if (!Number.isFinite(sl) || !(qty > 0)) return null;
    const risk = Math.abs(trade.entryPrice - Number(sl)) * qty;
    if (!(risk > 0)) return null;
    return net / risk;
  }
}
