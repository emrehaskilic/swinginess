/**
 * LiquidationHeatmap
 *
 * Tracks forced liquidation events from Binance's `forceOrder` stream and builds
 * a price-bucketed heatmap of cumulative liquidation volume.
 *
 * Use cases:
 *   1. TP targeting: place take-profit just BEFORE the nearest high-density
 *      liquidation cluster (price is magnetically attracted to flush that liquidity).
 *   2. Squeeze detection: large SHORT liquidation cluster above price + negative
 *      funding → potential violent long squeeze signal.
 *   3. Post-liquidation reversal: detect when a cascade ends (volume spikes then
 *      collapses) → mean-reversion window opens.
 *
 * Data source: Binance `wss://fstream.binance.com/ws/<symbol>@forceOrder`
 *   Each event: { o: { s, S (side), q (qty), ap (avg price), X (status) } }
 */

export interface LiquidationEvent {
  symbol: string;
  side: 'BUY' | 'SELL';        // BUY = short squeezed (shorts liq'd), SELL = long liq'd
  qty: number;
  price: number;
  timestampMs: number;
}

export interface LiquidationCluster {
  priceLevel: number;           // bucket center price
  totalQty: number;             // cumulative liquidated qty
  longLiqQty: number;           // SELL side (long positions liquidated)
  shortLiqQty: number;          // BUY side (short positions liquidated)
  lastSeenMs: number;
}

export interface LiquidationHeatmapSnapshot {
  symbol: string;
  timestampMs: number;
  clusters: LiquidationCluster[];       // sorted by totalQty desc
  nearestLongLiqAbove: number | null;   // nearest short-squeeze cluster above price
  nearestLongLiqBelow: number | null;   // nearest long-flush cluster below price
  recentCascadeActive: boolean;         // true if large cascade is in progress now
  recentCascadeVolume: number;          // total qty in last cascade window
}

export interface LiquidationHeatmapConfig {
  /** Price bucket size as fraction (e.g. 0.005 = 0.5% buckets) */
  bucketPct: number;
  /** How long to keep a bucket alive (ms) */
  decayMs: number;
  /** Rolling window for cascade detection (ms) */
  cascadeWindowMs: number;
  /** Volume threshold to consider a cascade active */
  cascadeVolumeThreshold: number;
  /** Max buckets to keep */
  maxBuckets: number;
}

const DEFAULT_CONFIG: LiquidationHeatmapConfig = {
  bucketPct: 0.005,               // 0.5% price buckets
  decayMs: 4 * 60 * 60 * 1000,   // 4-hour decay
  cascadeWindowMs: 30 * 1000,     // 30-second cascade detection
  cascadeVolumeThreshold: 50,     // 50 contracts in 30s = cascade
  maxBuckets: 500,
};

export class LiquidationHeatmap {
  private readonly config: LiquidationHeatmapConfig;
  private readonly buckets = new Map<number, LiquidationCluster>();
  private readonly recentEvents: LiquidationEvent[] = [];
  private symbol: string;

  constructor(symbol: string, config?: Partial<LiquidationHeatmapConfig>) {
    this.symbol = symbol.toUpperCase();
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  }

  // ---------------------------------------------------------------------------
  // Ingest a liquidation event (called from WebSocket handler)
  // ---------------------------------------------------------------------------

  ingest(event: LiquidationEvent): void {
    if (event.symbol.toUpperCase() !== this.symbol) return;
    if (!(event.qty > 0) || !(event.price > 0)) return;

    // Snap to bucket
    const bucketKey = this.snapToBucket(event.price);
    const existing = this.buckets.get(bucketKey);
    if (existing) {
      existing.totalQty += event.qty;
      if (event.side === 'SELL') existing.longLiqQty += event.qty;
      else existing.shortLiqQty += event.qty;
      existing.lastSeenMs = event.timestampMs;
    } else {
      this.buckets.set(bucketKey, {
        priceLevel: bucketKey,
        totalQty: event.qty,
        longLiqQty: event.side === 'SELL' ? event.qty : 0,
        shortLiqQty: event.side === 'BUY' ? event.qty : 0,
        lastSeenMs: event.timestampMs,
      });
    }

    // Track for cascade detection
    this.recentEvents.push(event);

    // Prune decayed buckets and old events periodically
    if (this.buckets.size > this.config.maxBuckets || Math.random() < 0.01) {
      this.pruneDecayed(event.timestampMs);
    }
  }

  // ---------------------------------------------------------------------------
  // Parse Binance forceOrder WebSocket message
  // ---------------------------------------------------------------------------

  parseAndIngest(rawMessage: unknown, nowMs?: number): void {
    try {
      const msg = rawMessage as Record<string, unknown>;
      const o = msg['o'] as Record<string, unknown> | undefined;
      if (!o) return;
      const symbol = String(o['s'] ?? '').toUpperCase();
      const side = String(o['S'] ?? '') as 'BUY' | 'SELL';
      const qty = Number(o['q'] ?? 0);
      const price = Number(o['ap'] ?? o['p'] ?? 0);
      const ts = Number(o['T'] ?? nowMs ?? Date.now());
      if (symbol !== this.symbol || !['BUY', 'SELL'].includes(side)) return;
      this.ingest({ symbol, side, qty, price, timestampMs: ts });
    } catch {
      // Malformed message — ignore
    }
  }

  // ---------------------------------------------------------------------------
  // Generate heatmap snapshot for the current price
  // ---------------------------------------------------------------------------

  snapshot(currentPrice: number, nowMs?: number): LiquidationHeatmapSnapshot {
    const ts = nowMs ?? Date.now();
    this.pruneDecayed(ts);

    const clusters = Array.from(this.buckets.values())
      .sort((a, b) => b.totalQty - a.totalQty)
      .slice(0, 50);

    // Nearest short-squeeze cluster above price (shorts will be liquidated → upward force)
    const shortLiqClusters = clusters.filter(c => c.shortLiqQty > 0 && c.priceLevel > currentPrice);
    const nearestLongLiqAbove = shortLiqClusters.length > 0
      ? shortLiqClusters.reduce((prev, cur) => cur.priceLevel < prev.priceLevel ? cur : prev).priceLevel
      : null;

    // Nearest long-flush cluster below price (longs will be liquidated → downward force)
    const longLiqClusters = clusters.filter(c => c.longLiqQty > 0 && c.priceLevel < currentPrice);
    const nearestLongLiqBelow = longLiqClusters.length > 0
      ? longLiqClusters.reduce((prev, cur) => cur.priceLevel > prev.priceLevel ? cur : prev).priceLevel
      : null;

    // Cascade detection
    const cascadeWindowStart = ts - this.config.cascadeWindowMs;
    const recentQty = this.recentEvents
      .filter(e => e.timestampMs >= cascadeWindowStart)
      .reduce((sum, e) => sum + e.qty, 0);
    const recentCascadeActive = recentQty >= this.config.cascadeVolumeThreshold;

    return {
      symbol: this.symbol,
      timestampMs: ts,
      clusters,
      nearestLongLiqAbove,
      nearestLongLiqBelow,
      recentCascadeActive,
      recentCascadeVolume: recentQty,
    };
  }

  // ---------------------------------------------------------------------------
  // Squeeze signal: potential long squeeze (rapid upward move) likely
  // Returns: 0 = no signal, positive = squeeze probability (0–1)
  // ---------------------------------------------------------------------------

  getShortSqueezeSignal(currentPrice: number, fundingRate: number | null, nowMs?: number): number {
    const snap = this.snapshot(currentPrice, nowMs);
    if (!snap.nearestLongLiqAbove) return 0;

    const distancePct = (snap.nearestLongLiqAbove - currentPrice) / currentPrice;
    if (distancePct > 0.05) return 0; // cluster too far away (>5%)

    const clusterAbove = snap.clusters.find(c => c.priceLevel === snap.nearestLongLiqAbove);
    if (!clusterAbove) return 0;

    // Stronger signal when: cluster is large, nearby, and funding is negative (shorts crowded)
    const proximityScore = 1 - Math.min(1, distancePct / 0.05);
    const volumeScore = Math.min(1, clusterAbove.shortLiqQty / 200);
    const fundingBonus = (fundingRate !== null && fundingRate < -0.0001) ? 0.2 : 0;

    return Math.min(1, proximityScore * 0.5 + volumeScore * 0.3 + fundingBonus);
  }

  // ---------------------------------------------------------------------------
  // Suggest take-profit level based on liquidation clusters
  // Returns: optimal TP price level or null
  // ---------------------------------------------------------------------------

  suggestTakeProfit(
    currentPrice: number,
    side: 'LONG' | 'SHORT',
    minDistancePct = 0.002,
    maxDistancePct = 0.05,
    nowMs?: number,
  ): number | null {
    const snap = this.snapshot(currentPrice, nowMs);

    if (side === 'LONG') {
      // Target the nearest dense cluster of SHORT liquidations above current price
      // (those shorts will be forced to buy back → fuels the move)
      const candidates = snap.clusters
        .filter(c => c.shortLiqQty > 0 && c.priceLevel > currentPrice)
        .filter(c => {
          const pct = (c.priceLevel - currentPrice) / currentPrice;
          return pct >= minDistancePct && pct <= maxDistancePct;
        })
        .sort((a, b) => b.shortLiqQty - a.shortLiqQty);

      if (candidates.length > 0) {
        // Place TP just BEFORE the cluster so we exit before the reversal
        return candidates[0].priceLevel * 0.9985;
      }
    } else {
      // SHORT: target nearest dense cluster of LONG liquidations below price
      const candidates = snap.clusters
        .filter(c => c.longLiqQty > 0 && c.priceLevel < currentPrice)
        .filter(c => {
          const pct = (currentPrice - c.priceLevel) / currentPrice;
          return pct >= minDistancePct && pct <= maxDistancePct;
        })
        .sort((a, b) => b.longLiqQty - a.longLiqQty);

      if (candidates.length > 0) {
        return candidates[0].priceLevel * 1.0015;
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private snapToBucket(price: number): number {
    const bucketSize = price * this.config.bucketPct;
    return Math.round(price / bucketSize) * bucketSize;
  }

  private pruneDecayed(nowMs: number): void {
    const cutoff = nowMs - this.config.decayMs;
    for (const [key, cluster] of this.buckets.entries()) {
      if (cluster.lastSeenMs < cutoff) {
        this.buckets.delete(key);
      }
    }
    // Prune recent events outside cascade window (keep 5 minutes for safety)
    const eventCutoff = nowMs - Math.max(this.config.cascadeWindowMs, 5 * 60 * 1000);
    while (this.recentEvents.length > 0 && this.recentEvents[0].timestampMs < eventCutoff) {
      this.recentEvents.shift();
    }
  }

  getSymbol(): string { return this.symbol; }
  getBucketCount(): number { return this.buckets.size; }
}
