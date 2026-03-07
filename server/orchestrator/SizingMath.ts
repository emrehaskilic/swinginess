export interface SizingComputation {
  markPrice: number;
  startingMarginUsdt: number;
  currentMarginBudgetUsdt: number;
  rampMult: number;
  leverage: number;
  notionalUsdt: number;
  qty: number;
  qtyRounded: number;
  minNotionalOk: boolean;
  marginRequiredUsdt: number;
  blockedReason: 'min_notional' | null;
}

export function roundDownToStep(rawQty: number, stepSize: number): number {
  if (!Number.isFinite(rawQty) || rawQty <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return 0;
  const units = Math.floor(rawQty / stepSize);
  return units * stepSize;
}

export function stepDigits(stepSize: number): number {
  const stepString = stepSize.toString();
  if (!stepString.includes('.')) return 0;
  return stepString.split('.')[1].replace(/0+$/, '').length;
}

export function computeSizingFromBudget(input: {
  startingMarginUsdt: number;
  currentMarginBudgetUsdt: number;
  leverage: number;
  markPrice: number;
  stepSize: number;
  minNotionalUsdt: number;
}): SizingComputation {
  const notionalUsdt = input.currentMarginBudgetUsdt * input.leverage;
  const qty = input.markPrice > 0 ? notionalUsdt / input.markPrice : 0;
  const qtyRounded = roundDownToStep(qty, input.stepSize);
  const computedNotional = qtyRounded * input.markPrice;
  const minNotionalOk = computedNotional >= input.minNotionalUsdt;
  const blockedReason = qtyRounded <= 0 || !minNotionalOk ? 'min_notional' : null;

  return {
    markPrice: input.markPrice,
    startingMarginUsdt: input.startingMarginUsdt,
    currentMarginBudgetUsdt: input.currentMarginBudgetUsdt,
    rampMult: input.startingMarginUsdt > 0 ? input.currentMarginBudgetUsdt / input.startingMarginUsdt : 0,
    leverage: input.leverage,
    notionalUsdt: computedNotional,
    qty,
    qtyRounded,
    minNotionalOk,
    marginRequiredUsdt: input.leverage > 0 ? computedNotional / input.leverage : computedNotional,
    blockedReason,
  };
}
