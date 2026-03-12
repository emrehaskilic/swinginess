/**
 * SwingRunService — UniRenko + Swing Structure (HH/HL/LH/LL) paper-trading module.
 *
 * Independent from NewStrategyV11. Shares only the live price feed.
 *
 *   UniRenkoBuilder  — converts raw price ticks → UniRenko bars (symbol-% brick size)
 *   SwingDetector    — 3-bar pivot detection → HH / HL / LH / LL labelling
 *   Position manager — pyramiding (up to maxPyramidLevels), structural stop, PnL
 *   Fill simulation  — market order with 0.05% slippage (both entry and exit)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UniRenkoBar {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    direction: 'UP' | 'DOWN';
    timestamp: number;
    index: number;
}

export type PivotLabel = 'HH' | 'HL' | 'LH' | 'LL';
export type SwingTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface PivotPoint {
    price: number;
    type: 'HIGH' | 'LOW';
    label: PivotLabel;
    barIndex: number;
    timestamp: number;
}

export interface FillEvent {
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    action: 'ENTRY' | 'PYRAMID' | 'EXIT';
    pyramidLevel: number;
    signalPrice: number;         // price when signal fired
    fillPrice: number;           // actual fill = signal ± slippage
    slippagePct: number;
    qty: number;
    notionalUsdt: number;
    feePaid: number;
    timestamp: number;
    status: 'FILLED';            // market orders always fill immediately
    reason: string;
}

export interface PyramidEntry {
    level: number;
    fillPrice: number;
    signalPrice: number;
    qty: number;
    notionalUsdt: number;
    timestamp: number;
}

export interface SwingPosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entries: PyramidEntry[];
    avgEntryPrice: number;
    totalQty: number;
    stopLevel: number;
    openTimestamp: number;
}

export interface SwingTrade {
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    maxPyramidLevel: number;
    avgEntryPrice: number;
    exitFillPrice: number;
    exitSignalPrice: number;
    totalQty: number;
    pnlUsdt: number;
    pnlPct: number;              // leveraged %
    feePaid: number;
    reason: string;
    openTimestamp: number;
    closeTimestamp: number;
    fills: FillEvent[];
}

export interface SwingBootstrapStatus {
    done: boolean;
    klinesTotal: number;    // requested
    barsLoaded: number;     // klines fetched so far
    renkoBuilt: number;     // UniRenko bars generated from historical data
    error: string | null;
}

export interface SwingSymbolStatus {
    symbol: string;
    markPrice: number;
    trend: SwingTrend;
    barsCount: number;
    recentBars: UniRenkoBar[];
    recentPivots: PivotPoint[];
    position: SwingPosition | null;
    unrealizedPnl: number;
    unrealizedPnlPct: number;    // leveraged %
    realizedPnl: number;
    feePaid: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    recentTrades: SwingTrade[];  // last 5
    recentFills: FillEvent[];    // last 20 across all trades for this symbol
    lastEventTs: number;
    bootstrap: SwingBootstrapStatus;
}

export interface SwingRunStatus {
    running: boolean;
    config: SwingRunConfig | null;
    summary: {
        totalRealizedPnl: number;
        totalUnrealizedPnl: number;
        totalFeePaid: number;
        totalTrades: number;
        winCount: number;
        lossCount: number;
        winRate: number;
    };
    perSymbol: Record<string, SwingSymbolStatus>;
}

export interface SwingRunConfig {
    symbols: string[];
    walletUsdt: number;
    marginPerSymbolUsdt: number;
    leverage: number;
    brickPct: number;
    maxPyramidLevels: number;
    takerFeeRate: number;
    slippagePct: number;         // default 0.0005 = 0.05%
    bootstrapKlines: number;     // how many historical 1m bars to pre-load (default 500)
}

// ─── UniRenko Builder ─────────────────────────────────────────────────────────

class UniRenkoBuilder {
    private referencePrice = 0;
    private brickSize = 0;
    private barCount = 0;
    private readonly brickPct: number;

    constructor(brickPct: number) {
        this.brickPct = brickPct;
    }

    onPrice(price: number, volume: number, ts: number): UniRenkoBar[] {
        const bars: UniRenkoBar[] = [];

        if (this.referencePrice === 0) {
            this.referencePrice = price;
            this.brickSize = price * this.brickPct;
            return bars;
        }

        while (price >= this.referencePrice + this.brickSize) {
            const open = this.referencePrice;
            const close = this.referencePrice + this.brickSize;
            bars.push({ open, high: close, low: open, close, volume, direction: 'UP', timestamp: ts, index: this.barCount++ });
            this.referencePrice = close;
            this.brickSize = this.referencePrice * this.brickPct;
        }

        while (price <= this.referencePrice - this.brickSize) {
            const open = this.referencePrice;
            const close = this.referencePrice - this.brickSize;
            bars.push({ open, high: open, low: close, close, volume, direction: 'DOWN', timestamp: ts, index: this.barCount++ });
            this.referencePrice = close;
            this.brickSize = this.referencePrice * this.brickPct;
        }

        return bars;
    }

    reset(): void { this.referencePrice = 0; this.brickSize = 0; this.barCount = 0; }
}

// ─── Swing Detector ───────────────────────────────────────────────────────────

class SwingDetector {
    private allBars: UniRenkoBar[] = [];
    private pivotHighs: PivotPoint[] = [];
    private pivotLows: PivotPoint[] = [];
    public recentPivots: PivotPoint[] = [];
    public trend: SwingTrend = 'NEUTRAL';

    addBar(bar: UniRenkoBar): PivotPoint | null {
        this.allBars.push(bar);
        const n = this.allBars.length;
        if (n < 2) return null;

        const prev = this.allBars[n - 2];
        const curr = this.allBars[n - 1];

        let detected: PivotPoint | null = null;

        // UniRenko pivot rule: direction change IS a pivot.
        // UP → DOWN: the previous (UP) bar's top is a Pivot High.
        // DOWN → UP: the previous (DOWN) bar's bottom is a Pivot Low.

        if (prev.direction === 'UP' && curr.direction === 'DOWN') {
            const pivotPrice = prev.close; // top of last UP bar
            const lastHigh = this.pivotHighs[this.pivotHighs.length - 1];
            const label: PivotLabel = (!lastHigh || pivotPrice > lastHigh.price) ? 'HH' : 'LH';
            const pivot: PivotPoint = { price: pivotPrice, type: 'HIGH', label, barIndex: prev.index, timestamp: prev.timestamp };
            this.pivotHighs.push(pivot);
            if (this.pivotHighs.length > 50) this.pivotHighs.shift();
            detected = pivot;
        }

        if (prev.direction === 'DOWN' && curr.direction === 'UP') {
            const pivotPrice = prev.close; // bottom of last DOWN bar
            const lastLow = this.pivotLows[this.pivotLows.length - 1];
            const label: PivotLabel = (!lastLow || pivotPrice > lastLow.price) ? 'HL' : 'LL';
            const pivot: PivotPoint = { price: pivotPrice, type: 'LOW', label, barIndex: prev.index, timestamp: prev.timestamp };
            this.pivotLows.push(pivot);
            if (this.pivotLows.length > 50) this.pivotLows.shift();
            if (!detected) detected = pivot;
        }

        if (detected) {
            this.recentPivots.push(detected);
            if (this.recentPivots.length > 20) this.recentPivots.shift();
            this._updateTrend();
        }

        return detected;
    }

    private _updateTrend(): void {
        const h = this.pivotHighs;
        const l = this.pivotLows;
        if (h.length < 2 || l.length < 2) { this.trend = 'NEUTRAL'; return; }

        const hhHL = h[h.length - 1].price > h[h.length - 2].price && l[l.length - 1].price > l[l.length - 2].price;
        const lhLL = h[h.length - 1].price < h[h.length - 2].price && l[l.length - 1].price < l[l.length - 2].price;

        this.trend = hhHL ? 'BULLISH' : lhLL ? 'BEARISH' : 'NEUTRAL';
    }

    getLastPivotHigh(): PivotPoint | null { return this.pivotHighs[this.pivotHighs.length - 1] ?? null; }
    getLastPivotLow(): PivotPoint | null  { return this.pivotLows[this.pivotLows.length - 1] ?? null; }

    reset(): void {
        this.allBars = []; this.pivotHighs = []; this.pivotLows = [];
        this.recentPivots = []; this.trend = 'NEUTRAL';
    }
}

// ─── Per-Symbol Runtime ───────────────────────────────────────────────────────

interface SymbolRuntime {
    builder: UniRenkoBuilder;
    detector: SwingDetector;
    allBars: UniRenkoBar[];
    position: SwingPosition | null;
    realizedPnl: number;
    feePaid: number;
    trades: SwingTrade[];
    fills: FillEvent[];
    markPrice: number;
    lastEventTs: number;
    lastPyramidPivotTs: number;
    fillSeq: number;
    tradeSeq: number;
    bootstrapping: boolean;          // true while pre-loading historical data
    bootstrap: SwingBootstrapStatus;
}

const PYRAMID_WEIGHT: Record<number, number> = { 1: 0.5, 2: 0.3, 3: 0.2 };

// ─── Main Service ─────────────────────────────────────────────────────────────

export type SwingExternalTrend = 'LONG' | 'SHORT' | 'NEUTRAL';

export class SwingRunService {
    private config: SwingRunConfig | null = null;
    private running = false;
    private runtimes = new Map<string, SymbolRuntime>();
    /**
     * External trend bias fed from the dry-run runtime context (bias15m + trendState).
     * LONG  → only LONG entries allowed
     * SHORT → only SHORT entries allowed
     * NEUTRAL → no new entries (wait for clear direction)
     */
    private externalTrendBySymbol = new Map<string, SwingExternalTrend>();

    start(cfg: SwingRunConfig, restBaseUrl: string): void {
        this.config = {
            ...cfg,
            brickPct:         Math.max(0.0005, Math.min(0.01, cfg.brickPct)),
            maxPyramidLevels: Math.max(1, Math.min(3, cfg.maxPyramidLevels)),
            takerFeeRate:     cfg.takerFeeRate > 0 ? cfg.takerFeeRate : 0.0005,
            slippagePct:      cfg.slippagePct  > 0 ? cfg.slippagePct  : 0.0005,
            bootstrapKlines:  cfg.bootstrapKlines > 0 ? Math.min(cfg.bootstrapKlines, 1500) : 500,
        };
        this.runtimes.clear();
        for (const sym of this.config.symbols) {
            this.runtimes.set(sym, {
                builder: new UniRenkoBuilder(this.config.brickPct),
                detector: new SwingDetector(),
                allBars: [],
                position: null,
                realizedPnl: 0,
                feePaid: 0,
                trades: [],
                fills: [],
                markPrice: 0,
                lastEventTs: 0,
                lastPyramidPivotTs: 0,
                fillSeq: 0,
                tradeSeq: 0,
                bootstrapping: true,
                bootstrap: { done: false, klinesTotal: this.config.bootstrapKlines, barsLoaded: 0, renkoBuilt: 0, error: null },
            });
        }
        this.running = true;
        // Fire bootstrap for all symbols in parallel (non-blocking)
        void this._bootstrapAll(restBaseUrl);
    }

    stop(): void { this.running = false; }

    // ─── Bootstrap ────────────────────────────────────────────────────────────

    private async _bootstrapAll(restBaseUrl: string): Promise<void> {
        const cfg = this.config!;
        await Promise.all(cfg.symbols.map(sym => this._bootstrapSymbol(sym, restBaseUrl, cfg.bootstrapKlines)));
    }

    private async _bootstrapSymbol(symbol: string, restBaseUrl: string, limit: number): Promise<void> {
        const rt = this.runtimes.get(symbol);
        if (!rt) return;

        try {
            const url = `${restBaseUrl}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`http_${res.status}`);

            const raw = (await res.json()) as unknown[][];
            if (!Array.isArray(raw)) throw new Error('invalid_response');

            rt.bootstrap.barsLoaded = raw.length;

            // Replay each 1m kline through the UniRenko builder.
            // Price path per kline:
            //   Bullish (close >= open): open → low → high → close
            //   Bearish (close <  open): open → high → low → close
            for (const row of raw) {
                const ts    = Number(row[0]);
                const open  = Number(row[1]);
                const high  = Number(row[2]);
                const low   = Number(row[3]);
                const close = Number(row[4]);
                const vol   = Number(row[5]) / 4;  // split across 4 ticks
                if (!isFinite(open) || open <= 0) continue;

                const bullish = close >= open;
                const path = bullish
                    ? [open, low, high, close]
                    : [open, high, low, close];

                for (const price of path) {
                    const newBars = rt.builder.onPrice(price, vol, ts);
                    for (const bar of newBars) {
                        rt.allBars.push(bar);
                        if (rt.allBars.length > 500) rt.allBars.shift();
                        rt.detector.addBar(bar);   // build pivots — no position opens
                    }
                }
            }

            rt.bootstrap.renkoBuilt = rt.allBars.length;
            rt.bootstrap.done = true;
            rt.bootstrapping = false;

            // ── Immediate entry if trend already confirmed from historical data ──
            this._tryImmediateEntry(symbol, rt);

        } catch (err: any) {
            rt.bootstrap.error = err?.message ?? 'bootstrap_failed';
            rt.bootstrap.done = true;
            rt.bootstrapping = false;

            // Still try immediate entry even if bootstrap partially failed
            this._tryImmediateEntry(symbol, rt);
        }
    }

    private _tryImmediateEntry(symbol: string, rt: SymbolRuntime): void {
        // Don't enter if no live price yet or position already open
        if (rt.markPrice <= 0 || rt.position) return;

        const trend = rt.detector.trend;
        const ts    = rt.lastEventTs > 0 ? rt.lastEventTs : Date.now();

        // Apply the same external trend filter as _onPivot — bootstrap must not
        // open positions against the dry-run direction.
        const externalTrend = this.getExternalTrend(symbol);
        const longAllowed   = externalTrend === 'LONG';
        const shortAllowed  = externalTrend === 'SHORT';

        if (trend === 'BULLISH' && longAllowed) {
            const lastLow = rt.detector.getLastPivotLow();
            if (lastLow) {
                this._openPosition(symbol, rt, 'LONG', rt.markPrice, lastLow.price, ts);
            }
        } else if (trend === 'BEARISH' && shortAllowed) {
            const lastHigh = rt.detector.getLastPivotHigh();
            if (lastHigh) {
                this._openPosition(symbol, rt, 'SHORT', rt.markPrice, lastHigh.price, ts);
            }
        }
        // NEUTRAL external trend or mismatch → no entry, wait for live pivot
    }

    onPrice(symbol: string, price: number, volume: number, ts: number): void {
        if (!this.running || !this.config) return;
        const rt = this.runtimes.get(symbol);
        if (!rt) return;

        rt.markPrice = price;
        rt.lastEventTs = ts;

        // While bootstrapping: just track mark price, skip trading logic
        if (rt.bootstrapping) return;

        if (rt.position) this._checkStop(symbol, rt, price, ts);

        const newBars = rt.builder.onPrice(price, volume, ts);
        for (const bar of newBars) {
            rt.allBars.push(bar);
            if (rt.allBars.length > 500) rt.allBars.shift();
            const pivot = rt.detector.addBar(bar);
            if (pivot) this._onPivot(symbol, rt, pivot, price, ts);
        }
    }

    private _fillPrice(signalPrice: number, side: 'LONG' | 'SHORT'): number {
        const slip = this.config!.slippagePct;
        // LONG entry: buy at slightly higher price (ask side)
        // SHORT entry: sell at slightly lower price (bid side)
        return side === 'LONG' ? signalPrice * (1 + slip) : signalPrice * (1 - slip);
    }

    private _exitFillPrice(signalPrice: number, side: 'LONG' | 'SHORT'): number {
        // Closing a LONG = selling = fills lower; closing SHORT = buying = fills higher
        return side === 'LONG' ? signalPrice * (1 - this.config!.slippagePct) : signalPrice * (1 + this.config!.slippagePct);
    }

    private _onPivot(symbol: string, rt: SymbolRuntime, pivot: PivotPoint, price: number, ts: number): void {
        const trend = rt.detector.trend;

        if (!rt.position) {
            // External trend filter: only enter in the direction the dry-run runtime confirms.
            // LONG → only BULLISH swing entries; SHORT → only BEARISH; NEUTRAL → no entry.
            const externalTrend = this.getExternalTrend(symbol);
            const longAllowed  = externalTrend === 'LONG';
            const shortAllowed = externalTrend === 'SHORT';

            if (trend === 'BULLISH' && longAllowed) {
                const lastLow = rt.detector.getLastPivotLow();
                if (lastLow) this._openPosition(symbol, rt, 'LONG', price, lastLow.price, ts);
            } else if (trend === 'BEARISH' && shortAllowed) {
                const lastHigh = rt.detector.getLastPivotHigh();
                if (lastHigh) this._openPosition(symbol, rt, 'SHORT', price, lastHigh.price, ts);
            }
            return;
        }

        const pos = rt.position;

        if (pos.side === 'LONG') {
            // Exit only on confirmed BEARISH reversal — NEUTRAL means consolidation, not reversal.
            // Stop protection handles the actual risk during consolidation.
            if (trend === 'BEARISH') { this._closePosition(symbol, rt, price, ts, 'TREND_REVERSAL'); return; }
            if (pivot.type === 'LOW' && pivot.label === 'HL'
                && pos.entries.length < this.config!.maxPyramidLevels
                && pivot.timestamp !== rt.lastPyramidPivotTs) {
                rt.lastPyramidPivotTs = pivot.timestamp;
                this._addPyramidEntry(symbol, rt, price, pos.entries.length + 1, ts);
                // Do NOT move stop up on pyramid — the original structural stop is still valid.
                // Moving stop to the new HL causes premature STOP_HIT on normal pullbacks.
            }
        }

        if (pos.side === 'SHORT') {
            // Exit only on confirmed BULLISH reversal — NEUTRAL means consolidation, not reversal.
            if (trend === 'BULLISH') { this._closePosition(symbol, rt, price, ts, 'TREND_REVERSAL'); return; }
            if (pivot.type === 'HIGH' && pivot.label === 'LH'
                && pos.entries.length < this.config!.maxPyramidLevels
                && pivot.timestamp !== rt.lastPyramidPivotTs) {
                rt.lastPyramidPivotTs = pivot.timestamp;
                this._addPyramidEntry(symbol, rt, price, pos.entries.length + 1, ts);
                // Do NOT move stop down on pyramid — the original structural stop is still valid.
            }
        }
    }

    private _checkStop(symbol: string, rt: SymbolRuntime, price: number, ts: number): void {
        const pos = rt.position!;
        if (pos.side === 'LONG'  && price <= pos.stopLevel) this._closePosition(symbol, rt, price, ts, 'STOP_HIT');
        if (pos.side === 'SHORT' && price >= pos.stopLevel) this._closePosition(symbol, rt, price, ts, 'STOP_HIT');
    }

    private _recordFill(
        rt: SymbolRuntime,
        symbol: string,
        action: FillEvent['action'],
        side: 'LONG' | 'SHORT',
        level: number,
        signalPrice: number,
        fillPrice: number,
        qty: number,
        notionalUsdt: number,
        feePaid: number,
        ts: number,
        reason: string,
    ): FillEvent {
        const cfg = this.config!;
        const fill: FillEvent = {
            id: `${symbol}-${++rt.fillSeq}`,
            symbol, side, action, pyramidLevel: level,
            signalPrice, fillPrice,
            slippagePct: cfg.slippagePct * 100,
            qty, notionalUsdt, feePaid,
            timestamp: ts,
            status: 'FILLED',
            reason,
        };
        rt.fills.push(fill);
        if (rt.fills.length > 100) rt.fills.shift();
        return fill;
    }

    private _openPosition(symbol: string, rt: SymbolRuntime, side: 'LONG' | 'SHORT', signalPrice: number, stopLevel: number, ts: number): void {
        const cfg = this.config!;
        const notional = cfg.marginPerSymbolUsdt * cfg.leverage * (PYRAMID_WEIGHT[1] ?? 0.5);
        const fill = this._fillPrice(signalPrice, side);
        const qty = notional / fill;
        const fee = notional * cfg.takerFeeRate;
        rt.feePaid += fee;

        this._recordFill(rt, symbol, 'ENTRY', side, 1, signalPrice, fill, qty, notional, fee, ts, 'SWING_ENTRY');

        rt.position = {
            symbol, side,
            entries: [{ level: 1, fillPrice: fill, signalPrice, qty, notionalUsdt: notional, timestamp: ts }],
            avgEntryPrice: fill,
            totalQty: qty,
            stopLevel,
            openTimestamp: ts,
        };
    }

    private _addPyramidEntry(symbol: string, rt: SymbolRuntime, signalPrice: number, level: number, ts: number): void {
        const cfg = this.config!;
        const pos = rt.position!;
        const weight = PYRAMID_WEIGHT[level] ?? 0.2;
        const notional = cfg.marginPerSymbolUsdt * cfg.leverage * weight;
        const fill = this._fillPrice(signalPrice, pos.side);
        const qty = notional / fill;
        const fee = notional * cfg.takerFeeRate;
        rt.feePaid += fee;

        this._recordFill(rt, symbol, 'PYRAMID', pos.side, level, signalPrice, fill, qty, notional, fee, ts, `PYRAMID_L${level}`);

        pos.entries.push({ level, fillPrice: fill, signalPrice, qty, notionalUsdt: notional, timestamp: ts });
        pos.totalQty += qty;
        const totalCost = pos.entries.reduce((s, e) => s + e.fillPrice * e.qty, 0);
        pos.avgEntryPrice = totalCost / pos.totalQty;
    }

    private _closePosition(symbol: string, rt: SymbolRuntime, signalPrice: number, ts: number, reason: string): void {
        const cfg = this.config!;
        const pos = rt.position!;
        const exitFill = this._exitFillPrice(signalPrice, pos.side);
        const totalNotional = pos.totalQty * exitFill;
        const fee = totalNotional * cfg.takerFeeRate;
        rt.feePaid += fee;

        const priceDelta = pos.side === 'LONG'
            ? exitFill - pos.avgEntryPrice
            : pos.avgEntryPrice - exitFill;
        const pnlUsdt = pos.totalQty * priceDelta - fee;
        const pnlPct = (priceDelta / pos.avgEntryPrice) * cfg.leverage * 100;

        rt.realizedPnl += pnlUsdt;

        const exitFillEvent = this._recordFill(
            rt, symbol, 'EXIT', pos.side, pos.entries.length,
            signalPrice, exitFill, pos.totalQty, totalNotional, fee, ts, reason,
        );

        const allFills = [...pos.entries.map((e, i) => rt.fills[rt.fills.length - 1 - (pos.entries.length - i)])].filter(Boolean);

        rt.trades.push({
            id: `${symbol}-T${++rt.tradeSeq}`,
            symbol,
            side: pos.side,
            maxPyramidLevel: pos.entries.length,
            avgEntryPrice: pos.avgEntryPrice,
            exitFillPrice: exitFill,
            exitSignalPrice: signalPrice,
            totalQty: pos.totalQty,
            pnlUsdt,
            pnlPct,
            feePaid: fee,
            reason,
            openTimestamp: pos.openTimestamp,
            closeTimestamp: ts,
            fills: [exitFillEvent],
        });

        rt.position = null;
    }

    // ─── External Trend Filter (fed from dry-run runtime context) ────────────

    /**
     * Called from index.ts after each strategy evaluation cycle.
     * Maps dry-run trendState → LONG | SHORT | NEUTRAL and stores it per symbol.
     * Swing run will only open new positions that align with this direction.
     */
    setExternalTrend(symbol: string, trend: SwingExternalTrend): void {
        this.externalTrendBySymbol.set(symbol.toUpperCase(), trend);
    }

    getExternalTrend(symbol: string): SwingExternalTrend {
        return this.externalTrendBySymbol.get(symbol.toUpperCase()) ?? 'NEUTRAL';
    }

    // ─── Status ───────────────────────────────────────────────────────────────

    getStatus(): SwingRunStatus {
        if (!this.running || !this.config) {
            return {
                running: false, config: null,
                summary: { totalRealizedPnl: 0, totalUnrealizedPnl: 0, totalFeePaid: 0, totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0 },
                perSymbol: {},
            };
        }

        let totalRealizedPnl = 0, totalUnrealizedPnl = 0, totalFeePaid = 0, totalTrades = 0, totalWins = 0;
        const perSymbol: Record<string, SwingSymbolStatus> = {};

        for (const [sym, rt] of this.runtimes) {
            let unrealizedPnl = 0, unrealizedPnlPct = 0;
            if (rt.position && rt.markPrice > 0) {
                const pos = rt.position;
                const delta = pos.side === 'LONG' ? rt.markPrice - pos.avgEntryPrice : pos.avgEntryPrice - rt.markPrice;
                unrealizedPnl = pos.totalQty * delta;
                unrealizedPnlPct = (delta / pos.avgEntryPrice) * this.config.leverage * 100;
            }

            const wins = rt.trades.filter(t => t.pnlUsdt > 0).length;

            perSymbol[sym] = {
                symbol: sym,
                markPrice: rt.markPrice,
                trend: rt.detector.trend,
                barsCount: rt.allBars.length,
                recentBars: rt.allBars.slice(-50),
                recentPivots: [...rt.detector.recentPivots],
                position: rt.position,
                unrealizedPnl,
                unrealizedPnlPct,
                realizedPnl: rt.realizedPnl,
                feePaid: rt.feePaid,
                tradeCount: rt.trades.length,
                winCount: wins,
                lossCount: rt.trades.length - wins,
                recentTrades: rt.trades.slice(-5),
                recentFills: rt.fills.slice(-20),
                lastEventTs: rt.lastEventTs,
                bootstrap: { ...rt.bootstrap },
            };

            totalRealizedPnl   += rt.realizedPnl;
            totalUnrealizedPnl += unrealizedPnl;
            totalFeePaid       += rt.feePaid;
            totalTrades        += rt.trades.length;
            totalWins          += wins;
        }

        return {
            running: true,
            config: this.config,
            summary: {
                totalRealizedPnl, totalUnrealizedPnl, totalFeePaid,
                totalTrades, winCount: totalWins,
                lossCount: totalTrades - totalWins,
                winRate: totalTrades > 0 ? totalWins / totalTrades : 0,
            },
            perSymbol,
        };
    }
}
