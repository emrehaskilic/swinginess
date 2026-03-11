import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getProxyApiBase } from '../services/proxyBase';
import { withProxyApiKey } from '../services/proxyAuth';

// ─── Types ────────────────────────────────────────────────────────────────────

type PivotLabel = 'HH' | 'HL' | 'LH' | 'LL';
type SwingTrend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface PivotPoint {
  price: number;
  type: 'HIGH' | 'LOW';
  label: PivotLabel;
  barIndex: number;
  timestamp: number;
}

interface FillEvent {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'ENTRY' | 'PYRAMID' | 'EXIT';
  pyramidLevel: number;
  signalPrice: number;
  fillPrice: number;
  slippagePct: number;
  qty: number;
  notionalUsdt: number;
  feePaid: number;
  timestamp: number;
  status: 'FILLED';
  reason: string;
}

interface SwingPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entries: Array<{ level: number; fillPrice: number; signalPrice: number; qty: number; notionalUsdt: number; timestamp: number }>;
  avgEntryPrice: number;
  totalQty: number;
  stopLevel: number;
  openTimestamp: number;
}

interface SwingTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  maxPyramidLevel: number;
  avgEntryPrice: number;
  exitFillPrice: number;
  exitSignalPrice: number;
  totalQty: number;
  pnlUsdt: number;
  pnlPct: number;
  feePaid: number;
  reason: string;
  openTimestamp: number;
  closeTimestamp: number;
}

interface SwingSymbolStatus {
  symbol: string;
  markPrice: number;
  trend: SwingTrend;
  barsCount: number;
  recentPivots: PivotPoint[];
  position: SwingPosition | null;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  feePaid: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  recentTrades: SwingTrade[];
  recentFills: FillEvent[];
  lastEventTs: number;
  bootstrap: {
    done: boolean;
    klinesTotal: number;
    barsLoaded: number;
    renkoBuilt: number;
    error: string | null;
  };
}

interface SwingRunConfig {
  symbols: string[];
  walletUsdt: number;
  marginPerSymbolUsdt: number;
  leverage: number;
  brickPct: number;
  maxPyramidLevels: number;
  takerFeeRate: number;
  slippagePct: number;
  bootstrapKlines: number;
}

interface SwingRunStatus {
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

// ─── API helpers ──────────────────────────────────────────────────────────────

const proxyBase = getProxyApiBase();

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${proxyBase}${path}`, withProxyApiKey({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  }));
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'unknown');
  return data;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${proxyBase}${path}`, withProxyApiKey({ cache: 'no-store' }));
  const data = await res.json();
  if (!data.ok) throw new Error(data.error ?? 'unknown');
  return data;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

const f2 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f4 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fTs = (ts: number) => ts > 0 ? new Date(ts).toLocaleTimeString() : '—';
const sign = (n: number) => n >= 0 ? '+' : '';

const pnlCls   = (v: number) => v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400';
const trendCls = (t: SwingTrend) => t === 'BULLISH' ? 'text-emerald-400' : t === 'BEARISH' ? 'text-red-400' : 'text-zinc-500';
const trendIcon = (t: SwingTrend) => t === 'BULLISH' ? '▲' : t === 'BEARISH' ? '▼' : '─';

const PIVOT_CLS: Record<PivotLabel, string> = {
  HH: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  HL: 'bg-emerald-900/30 text-emerald-400 border-emerald-800',
  LH: 'bg-red-900/30 text-red-400 border-red-800',
  LL: 'bg-red-900/60 text-red-300 border-red-700',
};

const ACTION_CLS: Record<FillEvent['action'], string> = {
  ENTRY:   'text-blue-400',
  PYRAMID: 'text-amber-400',
  EXIT:    'text-zinc-400',
};

const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];

const DEFAULT_STATUS: SwingRunStatus = {
  running: false, config: null,
  summary: { totalRealizedPnl: 0, totalUnrealizedPnl: 0, totalFeePaid: 0, totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0 },
  perSymbol: {},
};

// ─── Main Component ───────────────────────────────────────────────────────────

const SwingRunDashboard: React.FC = () => {
  // ── symbol picker state (same pattern as DryRun) ──
  const [availablePairs, setAvailablePairs] = useState<string[]>([]);
  const [selectedPairs, setSelectedPairs]   = useState<string[]>(DEFAULT_SYMBOLS);
  const [pairsLoading, setPairsLoading]     = useState(true);
  const [searchTerm, setSearchTerm]         = useState('');
  const [dropdownOpen, setDropdownOpen]     = useState(false);

  // ── config params ──
  const [wallet, setWallet]               = useState('10000');
  const [margin, setMargin]               = useState('250');
  const [leverage, setLeverage]           = useState('50');
  const [brickPct, setBrickPct]           = useState('0.05');  // displayed as %
  const [maxPyramid, setMaxPyramid]       = useState('3');
  const [bootstrapKlines, setBootstrap]   = useState('500');

  // ── runtime ──
  const [status, setStatus]         = useState<SwingRunStatus>(DEFAULT_STATUS);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting]       = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── load available pairs from existing dry-run symbols endpoint ──
  useEffect(() => {
    let active = true;
    setPairsLoading(true);
    apiGet<{ ok: boolean; symbols: string[] }>('/api/dry-run/symbols')
      .then(data => {
        if (!active) return;
        const pairs = (data.symbols || []).map((s: string) => s.toUpperCase()).filter(Boolean);
        setAvailablePairs(pairs.length ? pairs : DEFAULT_SYMBOLS);
        // keep user selection if valid, else default
        setSelectedPairs(prev => {
          const valid = prev.filter(p => pairs.includes(p));
          return valid.length ? valid : DEFAULT_SYMBOLS.filter(s => pairs.includes(s));
        });
      })
      .catch(() => setAvailablePairs(DEFAULT_SYMBOLS))
      .finally(() => { if (active) setPairsLoading(false); });
    return () => { active = false; };
  }, []);

  // ── poll status ──
  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiGet<{ ok: boolean; status: SwingRunStatus }>('/api/swing-run/status');
      setStatus(data.status);
    } catch { /* keep last */ }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  // ── symbol toggle ──
  const togglePair = (p: string) => {
    if (status.running) return;
    setSelectedPairs(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
  };

  const filteredPairs = useMemo(
    () => availablePairs.filter(p => p.includes(searchTerm.toUpperCase())),
    [availablePairs, searchTerm],
  );

  // ── start / stop ──
  const handleStart = async () => {
    if (selectedPairs.length === 0) { setActionError('En az 1 sembol seç.'); return; }
    setStarting(true); setActionError(null);
    try {
      await apiPost('/api/swing-run/start', {
        symbols:             selectedPairs,
        walletUsdt:          Number(wallet),
        marginPerSymbolUsdt: Number(margin),
        leverage:            Number(leverage),
        brickPct:            Number(brickPct) / 100,
        maxPyramidLevels:    Number(maxPyramid),
        takerFeeRate:        0.0005,
        slippagePct:         0.0005,
        bootstrapKlines:     Number(bootstrapKlines),
      });
      await fetchStatus();
    } catch (e: any) {
      setActionError(e?.message ?? 'start_failed');
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    await apiPost('/api/swing-run/stop').catch(() => null);
    await fetchStatus();
  };

  const { summary, running, config } = status;
  const symList = Object.values(status.perSymbol);
  const netPnl  = summary.totalRealizedPnl + summary.totalUnrealizedPnl - summary.totalFeePaid;

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-200 p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Swing Structure Run</h1>
            <p className="text-zinc-500 text-sm mt-1">
              DATA: MAINNET · MODE: PAPER · UniRenko + HH/HL/LH/LL · Yapısal Stop · Piramitleme
            </p>
          </div>
          <div className={`text-xs rounded border px-3 py-2 font-mono ${
            running ? 'border-emerald-700 bg-emerald-950/40 text-emerald-400' : 'border-zinc-700 bg-zinc-900 text-zinc-500'
          }`}>
            {running ? '● RUNNING' : '○ STOPPED'}
          </div>
        </div>

        {/* ── Control Panel ──────────────────────────────────────────── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-5">
          <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Control Panel</h2>

          {/* Symbol picker */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">Semboller</label>
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(v => !v)}
                disabled={running || pairsLoading}
                className="w-full flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm disabled:opacity-60 hover:border-zinc-600 transition-colors"
              >
                <span>{pairsLoading ? 'Yükleniyor…' : `${selectedPairs.length} sembol seçili`}</span>
                <span className="text-zinc-500">{dropdownOpen ? '▴' : '▾'}</span>
              </button>

              {/* Selected chips */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {selectedPairs.map(p => (
                  <span key={p} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-zinc-800 text-zinc-300 rounded-full border border-zinc-700">
                    {p}
                    {!running && (
                      <button onClick={() => togglePair(p)} className="text-zinc-500 hover:text-white transition-colors leading-none">×</button>
                    )}
                  </span>
                ))}
              </div>

              {/* Dropdown */}
              {dropdownOpen && !running && !pairsLoading && (
                <div className="absolute z-20 mt-1 w-full border border-zinc-700 rounded bg-[#18181b] p-2 shadow-2xl">
                  <input
                    autoFocus
                    placeholder="Sembol filtrele…"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="w-full bg-black border border-zinc-800 rounded px-2 py-1.5 text-xs mb-2 focus:outline-none focus:border-zinc-600"
                  />
                  <div className="max-h-52 overflow-y-auto space-y-0.5">
                    {filteredPairs.map(p => (
                      <button
                        key={p}
                        onClick={() => togglePair(p)}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center justify-between transition-colors ${
                          selectedPairs.includes(p) ? 'bg-zinc-700 text-white' : 'hover:bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        <span>{p}</span>
                        {selectedPairs.includes(p) && <span className="text-emerald-400 text-[10px]">✓</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Config grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {([
              ['Wallet (USDT)',        wallet,          setWallet,       '10000'],
              ['Margin/Sembol',        margin,          setMargin,       '250'],
              ['Kaldıraç',             leverage,        setLeverage,     '50'],
              ['Brick Boyutu (%)',     brickPct,        setBrickPct,     '0.05'],
              ['Max Piramit (1-3)',    maxPyramid,      setMaxPyramid,   '3'],
              ['Bootstrap Kline (1m)', bootstrapKlines, setBootstrap,   '500'],
            ] as [string, string, React.Dispatch<React.SetStateAction<string>>, string][]).map(([label, val, setter, ph]) => (
              <label key={label} className="text-xs text-zinc-500">
                {label}
                <input
                  type="number"
                  value={val}
                  onChange={e => setter(e.target.value)}
                  disabled={running}
                  placeholder={ph}
                  className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-2 text-sm font-mono text-zinc-100 disabled:opacity-50 focus:outline-none focus:border-zinc-600"
                />
              </label>
            ))}
          </div>

          {/* Info strip */}
          {running && config && (
            <div className="rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>Brick: <span className="text-zinc-300 font-mono">{(config.brickPct * 100).toFixed(3)}%</span></span>
              <span>Leverage: <span className="text-zinc-300 font-mono">{config.leverage}x</span></span>
              <span>Margin/sembol: <span className="text-zinc-300 font-mono">{f2(config.marginPerSymbolUsdt)} USDT</span></span>
              <span>Max piramit: <span className="text-zinc-300 font-mono">{config.maxPyramidLevels}</span></span>
                  <span>Slippage: <span className="text-zinc-300 font-mono">{(config.slippagePct * 100).toFixed(2)}%</span></span>
              <span>Fee: <span className="text-zinc-300 font-mono">{(config.takerFeeRate * 100).toFixed(3)}%</span></span>
              <span>Bootstrap: <span className="text-zinc-300 font-mono">{config.bootstrapKlines} 1m bar</span></span>
            </div>
          )}

          {actionError && (
            <div className="text-xs text-red-400 border border-red-900/50 bg-red-950/20 rounded px-3 py-2">{actionError}</div>
          )}

          {/* Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleStart}
              disabled={running || starting}
              className="px-3 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs font-bold text-white transition-colors"
            >
              {starting ? 'BAŞLATILIYOR…' : 'START SWING RUN'}
            </button>
            <button
              onClick={handleStop}
              disabled={!running}
              className="px-3 py-2 bg-amber-700 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed rounded text-xs font-bold text-white transition-colors"
            >
              STOP
            </button>
          </div>
        </div>

        {/* ── Summary Stats ──────────────────────────────────────────── */}
        {running && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {([
              ['Realized PnL',    `${sign(summary.totalRealizedPnl)}${f2(summary.totalRealizedPnl)} USDT`,  pnlCls(summary.totalRealizedPnl)],
              ['Unrealized PnL',  `${sign(summary.totalUnrealizedPnl)}${f2(summary.totalUnrealizedPnl)} USDT`, pnlCls(summary.totalUnrealizedPnl)],
              ['Net PnL (fee)',   `${sign(netPnl)}${f2(netPnl)} USDT`,                                      pnlCls(netPnl)],
              ['Fee Paid',        `-${f2(summary.totalFeePaid)} USDT`,                                       'text-zinc-500'],
              ['Trades',          `${summary.totalTrades}  (${summary.winCount}W / ${summary.lossCount}L)`, 'text-zinc-300'],
              ['Win Rate',        `${(summary.winRate * 100).toFixed(1)}%`,                                  summary.winRate >= 0.5 ? 'text-emerald-400' : 'text-red-400'],
            ] as [string, string, string][]).map(([label, value, cls]) => (
              <div key={label} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">{label}</p>
                <p className={`text-sm font-mono font-semibold ${cls}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Per-Symbol Cards ───────────────────────────────────────── */}
        {running && symList.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {symList.map(sym => <SymbolCard key={sym.symbol} sym={sym} leverage={config?.leverage ?? 50} />)}
          </div>
        )}

        {/* ── Global Fill Log ────────────────────────────────────────── */}
        {running && (
          <FillLog symList={symList} />
        )}
      </div>
    </div>
  );
};

// ─── Symbol Card ──────────────────────────────────────────────────────────────

const SymbolCard: React.FC<{ sym: SwingSymbolStatus; leverage: number }> = ({ sym }) => {
  const netPnl = sym.realizedPnl + sym.unrealizedPnl - sym.feePaid;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">

      {/* Card header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-zinc-100">{sym.symbol}</span>
          <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
            sym.trend === 'BULLISH' ? 'bg-emerald-900/50 text-emerald-300' :
            sym.trend === 'BEARISH' ? 'bg-red-900/50 text-red-300' : 'bg-zinc-800 text-zinc-500'
          }`}>
            {trendIcon(sym.trend)} {sym.trend}
          </span>
        </div>
        <div className="text-right">
          <p className="text-sm font-mono text-zinc-200">${f4(sym.markPrice)}</p>
          <p className="text-[10px] text-zinc-600 mt-0.5">{sym.barsCount} bars · {fTs(sym.lastEventTs)}</p>
        </div>
      </div>

      <div className="p-4 space-y-4">

        {/* Bootstrap progress */}
        {!sym.bootstrap.done && (
          <div className="border border-amber-800/50 bg-amber-950/20 rounded-lg px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-amber-400 font-semibold">Bootstrap yükleniyor…</span>
              <span className="font-mono text-amber-300">
                {sym.bootstrap.barsLoaded}/{sym.bootstrap.klinesTotal} 1m bar
              </span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-1.5">
              <div
                className="bg-amber-500 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${sym.bootstrap.klinesTotal > 0 ? (sym.bootstrap.barsLoaded / sym.bootstrap.klinesTotal) * 100 : 0}%` }}
              />
            </div>
            <p className="text-[10px] text-zinc-500">
              Trend oluşana kadar işlem yok · Tamamlandığında otomatik başlar
            </p>
          </div>
        )}

        {sym.bootstrap.done && sym.bootstrap.error && (
          <div className="text-xs text-amber-400 border border-amber-800/40 bg-amber-950/10 rounded px-2 py-1.5">
            Bootstrap hatası: {sym.bootstrap.error} — canlı veri ile devam ediliyor
          </div>
        )}

        {sym.bootstrap.done && !sym.bootstrap.error && sym.barsCount === 0 && (
          <div className="text-xs text-zinc-500 border border-zinc-800 rounded px-2 py-1.5">
            Bootstrap tamamlandı · UniRenko bar bekleniyor…
          </div>
        )}

        {sym.bootstrap.done && sym.barsCount > 0 && sym.recentPivots.length === 0 && (
          <div className="text-xs text-zinc-500 border border-zinc-800 rounded px-2 py-1.5">
            {sym.barsCount} UniRenko bar · Pivot oluşması bekleniyor…
          </div>
        )}

        {/* PnL row */}
        <div className="grid grid-cols-3 gap-2">
          {([
            ['Unrealized', sym.unrealizedPnl, sym.unrealizedPnlPct],
            ['Realized',   sym.realizedPnl,   null],
            ['Net',        netPnl,            null],
          ] as [string, number, number | null][]).map(([label, usd, pct]) => (
            <div key={label} className="bg-zinc-950 rounded p-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</p>
              <p className={`text-xs font-mono font-semibold mt-0.5 ${pnlCls(usd)}`}>
                {sign(usd)}{f2(usd)}
              </p>
              {pct != null && (
                <p className={`text-[10px] font-mono ${pnlCls(pct)}`}>{sign(pct)}{pct.toFixed(2)}%</p>
              )}
            </div>
          ))}
        </div>

        {/* Active position */}
        {sym.position ? (
          <PositionBox pos={sym.position} markPrice={sym.markPrice} />
        ) : (
          <div className="text-xs text-zinc-600 italic border border-dashed border-zinc-800 rounded px-3 py-2 text-center">
            Açık pozisyon yok
          </div>
        )}

        {/* Pivots */}
        {sym.recentPivots.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">Son Pivotlar</p>
            <div className="flex flex-wrap gap-1">
              {[...sym.recentPivots].reverse().slice(0, 12).map((p, i) => (
                <span
                  key={`${p.barIndex}-${i}`}
                  className={`text-[10px] font-mono font-bold rounded px-1.5 py-0.5 border ${PIVOT_CLS[p.label]}`}
                  title={`${p.label} @ $${f4(p.price)} · bar #${p.barIndex} · ${fTs(p.timestamp)}`}
                >
                  {p.label} {p.price < 10 ? f4(p.price) : f2(p.price)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Trade stats */}
        <div className="flex items-center justify-between text-xs border-t border-zinc-800 pt-3">
          <div className="flex items-center gap-3 text-zinc-500">
            <span>{sym.tradeCount} işlem</span>
            {sym.tradeCount > 0 && <>
              <span className="text-emerald-500">{sym.winCount}W</span>
              <span className="text-red-500">{sym.lossCount}L</span>
              <span>{sym.tradeCount > 0 ? ((sym.winCount / sym.tradeCount) * 100).toFixed(0) : 0}%</span>
            </>}
          </div>
          <span className="text-zinc-600">fee: {f2(sym.feePaid)} USDT</span>
        </div>

        {/* Last 3 trades */}
        {sym.recentTrades.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">Son İşlemler</p>
            <div className="space-y-1">
              {[...sym.recentTrades].reverse().slice(0, 3).map(t => (
                <div key={t.id} className="flex items-center justify-between text-[10px] bg-zinc-950 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className={`font-bold ${t.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side}</span>
                    <span className="text-zinc-600">L{t.maxPyramidLevel}</span>
                    <span className="text-zinc-500">{t.reason}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono font-semibold ${pnlCls(t.pnlUsdt)}`}>
                      {sign(t.pnlUsdt)}{f2(t.pnlUsdt)} USDT
                    </span>
                    <span className={`font-mono ${pnlCls(t.pnlPct)}`}>({sign(t.pnlPct)}{t.pnlPct.toFixed(1)}%)</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Position Box ─────────────────────────────────────────────────────────────

const PositionBox: React.FC<{ pos: SwingPosition; markPrice: number }> = ({ pos, markPrice }) => {
  const distToStop = pos.side === 'LONG'
    ? ((markPrice - pos.stopLevel) / markPrice) * 100
    : ((pos.stopLevel - markPrice) / markPrice) * 100;

  return (
    <div className={`border rounded-lg overflow-hidden ${
      pos.side === 'LONG' ? 'border-emerald-800/60' : 'border-red-800/60'
    }`}>
      <div className={`px-3 py-2 flex items-center justify-between ${
        pos.side === 'LONG' ? 'bg-emerald-950/40' : 'bg-red-950/40'
      }`}>
        <span className={`text-xs font-bold ${pos.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>
          {pos.side} — Piramit {pos.entries.length}. katman
        </span>
        <span className="text-[10px] text-zinc-500">{fTs(pos.openTimestamp)}</span>
      </div>
      <div className="px-3 py-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <p className="text-zinc-600">Ort. Giriş</p>
          <p className="font-mono text-zinc-200">${f4(pos.avgEntryPrice)}</p>
        </div>
        <div>
          <p className="text-zinc-600">Stop Seviyesi</p>
          <p className="font-mono text-red-400">${f4(pos.stopLevel)}</p>
          <p className="text-[10px] text-zinc-600 mt-0.5">
            {distToStop >= 0 ? `uzaklık: ${distToStop.toFixed(2)}%` : <span className="text-red-500">STOP AŞILDI</span>}
          </p>
        </div>
        <div>
          <p className="text-zinc-600">Toplam Qty</p>
          <p className="font-mono text-zinc-200">{pos.totalQty.toFixed(5)}</p>
        </div>
      </div>
      {/* Pyramid entry chips */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {pos.entries.map(e => (
          <div key={e.level} className="text-[10px] bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 font-mono text-zinc-300">
            L{e.level}: ${f4(e.fillPrice)}
            {e.signalPrice !== e.fillPrice && (
              <span className="text-zinc-600 ml-1">(sig ${f4(e.signalPrice)})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Fill Log ─────────────────────────────────────────────────────────────────

const FillLog: React.FC<{ symList: SwingSymbolStatus[] }> = ({ symList }) => {
  const allFills = useMemo(() => {
    const merged: FillEvent[] = [];
    for (const sym of symList) merged.push(...sym.recentFills);
    return merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, 30);
  }, [symList]);

  if (allFills.length === 0) return null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Fill Log</h2>
        <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Piyasa emirleri — anlık dolum</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-600 uppercase tracking-wider text-[10px]">
              <th className="text-left px-4 py-2">Zaman</th>
              <th className="text-left px-4 py-2">Sembol</th>
              <th className="text-left px-4 py-2">Yön</th>
              <th className="text-left px-4 py-2">İşlem</th>
              <th className="text-right px-4 py-2">Sinyal</th>
              <th className="text-right px-4 py-2">Dolum</th>
              <th className="text-right px-4 py-2">Slippage</th>
              <th className="text-right px-4 py-2">Notional</th>
              <th className="text-right px-4 py-2">Fee</th>
              <th className="text-left px-4 py-2">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {allFills.map(f => (
              <tr key={f.id} className="hover:bg-zinc-800/30 transition-colors">
                <td className="px-4 py-2 font-mono text-zinc-500">{fTs(f.timestamp)}</td>
                <td className="px-4 py-2 font-semibold text-zinc-300">{f.symbol}</td>
                <td className="px-4 py-2">
                  <span className={`font-bold ${f.side === 'LONG' ? 'text-emerald-400' : 'text-red-400'}`}>{f.side}</span>
                </td>
                <td className="px-4 py-2">
                  <span className={`font-mono ${ACTION_CLS[f.action]}`}>{f.action}</span>
                  {f.action === 'PYRAMID' && (
                    <span className="text-zinc-600 ml-1">L{f.pyramidLevel}</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-mono text-zinc-400">${f4(f.signalPrice)}</td>
                <td className="px-4 py-2 text-right font-mono text-zinc-200">${f4(f.fillPrice)}</td>
                <td className="px-4 py-2 text-right font-mono text-zinc-500">{f.slippagePct.toFixed(3)}%</td>
                <td className="px-4 py-2 text-right font-mono text-zinc-300">{f2(f.notionalUsdt)}</td>
                <td className="px-4 py-2 text-right font-mono text-zinc-500">-{f2(f.feePaid)}</td>
                <td className="px-4 py-2">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800/50 font-mono">
                    {f.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SwingRunDashboard;
