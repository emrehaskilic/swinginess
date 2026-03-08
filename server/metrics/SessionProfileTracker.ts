import type { AuctionAcceptance, AuctionLocation, SessionProfileSnapshot } from '../types/strategy';
import type { SessionName } from './SessionVwapTracker';

interface SessionWindow {
  name: SessionName;
  startHourUtc: number;
}

interface ProfileState {
  name: SessionName;
  sessionStartMs: number;
  totalVolume: number;
  bucketSize: number;
  histogram: Map<number, number>;
  recentTrades: Array<{ ts: number; price: number; quantity: number }>;
}

const DEFAULT_WINDOWS: SessionWindow[] = [
  { name: 'asia', startHourUtc: 0 },
  { name: 'london', startHourUtc: 8 },
  { name: 'ny', startHourUtc: 16 },
];

const ACCEPTANCE_WINDOW_MS = 90_000;
const MAX_RECENT_TRADES = 128;
const VALUE_AREA_PCT = 0.70;
const DEFAULT_BUCKET_BPS = Math.max(0.5, Number(process.env.SESSION_PROFILE_BUCKET_BPS || 5));

function parseStartHour(raw: string | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) {
    return fallback;
  }
  return parsed;
}

function buildWindowsFromEnv(): SessionWindow[] {
  const configured: SessionWindow[] = [
    {
      name: 'asia',
      startHourUtc: parseStartHour(process.env.SESSION_ASIA_START_UTC_HOUR, DEFAULT_WINDOWS[0].startHourUtc),
    },
    {
      name: 'london',
      startHourUtc: parseStartHour(process.env.SESSION_LONDON_START_UTC_HOUR, DEFAULT_WINDOWS[1].startHourUtc),
    },
    {
      name: 'ny',
      startHourUtc: parseStartHour(process.env.SESSION_NY_START_UTC_HOUR, DEFAULT_WINDOWS[2].startHourUtc),
    },
  ];
  return configured.sort((a, b) => a.startHourUtc - b.startHourUtc);
}

function resolveSession(timestampMs: number, windows: SessionWindow[]): { name: SessionName; sessionStartMs: number } {
  const ts = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const d = new Date(ts);
  const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  const minutesOfDay = (d.getUTCHours() * 60) + d.getUTCMinutes();

  let selected: SessionWindow | null = null;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const candidate = windows[index];
    if (minutesOfDay >= candidate.startHourUtc * 60) {
      selected = candidate;
      break;
    }
  }

  if (selected) {
    return {
      name: selected.name,
      sessionStartMs: dayStartMs + (selected.startHourUtc * 60 * 60 * 1000),
    };
  }

  const prev = windows[windows.length - 1];
  return {
    name: prev.name,
    sessionStartMs: (dayStartMs - (24 * 60 * 60 * 1000)) + (prev.startHourUtc * 60 * 60 * 1000),
  };
}

function resolveBucketSize(price: number): number {
  const px = Number(price);
  if (!(px > 0)) return 0.01;
  const bucket = px * (DEFAULT_BUCKET_BPS / 10_000);
  return Math.max(bucket, px * 0.00005, 0.00000001);
}

function roundToBucket(price: number, bucketSize: number): number {
  if (!(price > 0) || !(bucketSize > 0)) return 0;
  const units = Math.round(price / bucketSize);
  return Number((units * bucketSize).toFixed(10));
}

function toBps(delta: number, base: number): number | null {
  if (!(base > 0) || !Number.isFinite(delta)) return null;
  return (delta / base) * 10_000;
}

function resolveLocation(referencePrice: number, val: number, vah: number): AuctionLocation {
  if (!(referencePrice > 0 && val > 0 && vah > 0)) return 'UNKNOWN';
  if (referencePrice > vah) return 'ABOVE_VAH';
  if (referencePrice < val) return 'BELOW_VAL';
  return 'IN_VALUE';
}

function resolveAcceptance(
  recentTrades: Array<{ ts: number; price: number; quantity: number }>,
  nowMs: number,
  val: number,
  vah: number,
  location: AuctionLocation,
): AuctionAcceptance {
  const activeTrades = recentTrades.filter((trade) => (nowMs - trade.ts) <= ACCEPTANCE_WINDOW_MS);
  if (activeTrades.length === 0 || !(val > 0) || !(vah > 0)) return 'NEUTRAL';

  let totalVolume = 0;
  let aboveVolume = 0;
  let belowVolume = 0;
  let inValueVolume = 0;
  for (const trade of activeTrades) {
    const qty = Number(trade.quantity);
    if (!(qty > 0)) continue;
    totalVolume += qty;
    if (trade.price > vah) aboveVolume += qty;
    else if (trade.price < val) belowVolume += qty;
    else inValueVolume += qty;
  }
  if (!(totalVolume > 0)) return 'NEUTRAL';

  const aboveRatio = aboveVolume / totalVolume;
  const belowRatio = belowVolume / totalVolume;
  const inValueRatio = inValueVolume / totalVolume;

  if (location === 'ABOVE_VAH') {
    if (aboveRatio >= 0.65) return 'ACCEPTING_ABOVE';
    if (inValueRatio >= 0.55) return 'REJECTING_HIGH';
    return 'NEUTRAL';
  }
  if (location === 'BELOW_VAL') {
    if (belowRatio >= 0.65) return 'ACCEPTING_BELOW';
    if (inValueRatio >= 0.55) return 'REJECTING_LOW';
    return 'NEUTRAL';
  }
  if (inValueRatio >= 0.6) return 'ACCEPTING_VALUE';
  return 'NEUTRAL';
}

function computeValueArea(histogram: Map<number, number>, poc: number, totalVolume: number): { vah: number; val: number } {
  const priceLevels = Array.from(histogram.keys()).sort((a, b) => a - b);
  if (priceLevels.length === 0) {
    return { vah: 0, val: 0 };
  }

  const pocIndex = Math.max(0, priceLevels.indexOf(poc));
  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let accumulated = histogram.get(poc) || 0;
  const targetVolume = totalVolume * VALUE_AREA_PCT;

  while (accumulated < targetVolume && (lowIndex > 0 || highIndex < (priceLevels.length - 1))) {
    const nextLow = lowIndex > 0 ? priceLevels[lowIndex - 1] : null;
    const nextHigh = highIndex < (priceLevels.length - 1) ? priceLevels[highIndex + 1] : null;
    const nextLowVolume = nextLow == null ? -1 : (histogram.get(nextLow) || 0);
    const nextHighVolume = nextHigh == null ? -1 : (histogram.get(nextHigh) || 0);

    if (nextHighVolume >= nextLowVolume) {
      if (nextHigh != null) {
        highIndex += 1;
        accumulated += nextHighVolume;
      } else if (nextLow != null) {
        lowIndex -= 1;
        accumulated += nextLowVolume;
      }
    } else if (nextLow != null) {
      lowIndex -= 1;
      accumulated += nextLowVolume;
    } else if (nextHigh != null) {
      highIndex += 1;
      accumulated += nextHighVolume;
    }
  }

  return {
    vah: priceLevels[highIndex],
    val: priceLevels[lowIndex],
  };
}

export class SessionProfileTracker {
  private readonly windows: SessionWindow[];
  private state: ProfileState | null = null;

  constructor() {
    this.windows = buildWindowsFromEnv();
  }

  public update(tradeTimestampMs: number, price: number, quantity: number): void {
    this.rollSessionIfNeeded(tradeTimestampMs, price);
    if (!this.state) return;

    const px = Number(price);
    const qty = Number(quantity);
    if (!(px > 0) || !(qty > 0)) return;

    if (!(this.state.bucketSize > 0)) {
      this.state.bucketSize = resolveBucketSize(px);
    }

    const bucketPrice = roundToBucket(px, this.state.bucketSize);
    this.state.totalVolume += qty;
    this.state.histogram.set(bucketPrice, (this.state.histogram.get(bucketPrice) || 0) + qty);
    this.state.recentTrades.push({ ts: tradeTimestampMs, price: px, quantity: qty });
    if (this.state.recentTrades.length > MAX_RECENT_TRADES) {
      this.state.recentTrades.shift();
    }
  }

  public snapshot(nowMs: number, referencePrice: number | null | undefined): SessionProfileSnapshot {
    this.rollSessionIfNeeded(nowMs, Number(referencePrice || 0));
    if (!this.state) {
      const fallback = resolveSession(nowMs, this.windows);
      return {
        sessionName: fallback.name,
        sessionStartMs: fallback.sessionStartMs,
        bucketSize: 0,
        poc: null,
        vah: null,
        val: null,
        location: 'UNKNOWN',
        acceptance: 'NEUTRAL',
        distanceToPocBps: null,
        distanceToValueEdgeBps: null,
        totalVolume: 0,
      };
    }

    const ref = Number(referencePrice);
    if (!(this.state.totalVolume > 0) || this.state.histogram.size === 0) {
      return {
        sessionName: this.state.name,
        sessionStartMs: this.state.sessionStartMs,
        bucketSize: this.state.bucketSize,
        poc: null,
        vah: null,
        val: null,
        location: 'UNKNOWN',
        acceptance: 'NEUTRAL',
        distanceToPocBps: null,
        distanceToValueEdgeBps: null,
        totalVolume: this.state.totalVolume,
      };
    }

    const poc = Array.from(this.state.histogram.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] - b[0];
      })[0][0];
    const { vah, val } = computeValueArea(this.state.histogram, poc, this.state.totalVolume);
    const location = resolveLocation(ref, val, vah);
    const acceptance = resolveAcceptance(this.state.recentTrades, nowMs, val, vah, location);
    const distanceToPocBps = ref > 0 && poc > 0 ? toBps(ref - poc, poc) : null;
    const edgeReference = location === 'ABOVE_VAH'
      ? vah
      : location === 'BELOW_VAL'
        ? val
        : ref > 0
          ? (Math.abs(ref - vah) <= Math.abs(ref - val) ? vah : val)
          : 0;
    const distanceToValueEdgeBps = ref > 0 && edgeReference > 0 ? toBps(ref - edgeReference, edgeReference) : null;

    return {
      sessionName: this.state.name,
      sessionStartMs: this.state.sessionStartMs,
      bucketSize: this.state.bucketSize,
      poc,
      vah,
      val,
      location,
      acceptance,
      distanceToPocBps,
      distanceToValueEdgeBps,
      totalVolume: this.state.totalVolume,
    };
  }

  private rollSessionIfNeeded(timestampMs: number, referencePrice: number): void {
    const next = resolveSession(timestampMs, this.windows);
    if (this.state && this.state.sessionStartMs === next.sessionStartMs && this.state.name === next.name) {
      return;
    }
    this.state = {
      name: next.name,
      sessionStartMs: next.sessionStartMs,
      totalVolume: 0,
      bucketSize: resolveBucketSize(referencePrice),
      histogram: new Map<number, number>(),
      recentTrades: [],
    };
  }
}
