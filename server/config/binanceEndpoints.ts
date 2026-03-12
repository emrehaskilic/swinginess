/**
 * Centralized Binance endpoint configuration.
 *
 * Defaults to PRODUCTION endpoints (fapi.binance.com / fstream.binance.com).
 * Override via env vars BINANCE_REST_BASE / BINANCE_WS_BASE if needed.
 */

export const BINANCE_REST_BASE: string =
  process.env.BINANCE_REST_BASE || 'https://fapi.binance.com';

export const BINANCE_WS_BASE: string =
  process.env.BINANCE_WS_BASE || 'wss://fstream.binance.com/stream';
