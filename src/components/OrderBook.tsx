import React from 'react';

/**
 * Order book ladder component.  Displays the top levels of bids and
 * asks along with a depth bar that scales relative to the largest
 * cumulative size on either side.  Prices and sizes are colour coded.
 * The ``bids`` and ``asks`` props are arrays of `[price, size, total]`
 * where ``total`` is the cumulative size up to that level.  The
 * ``currentPrice`` is displayed between the ask and bid ladders.
 */
export interface OrderBookProps {
  bids?: [number, number, number][];
  asks?: [number, number, number][];
  currentPrice: number;
}

const OrderBook: React.FC<OrderBookProps> = ({ bids, asks, currentPrice }) => {
  // Ensure arrays are valid
  const safeBids = Array.isArray(bids) ? bids : [];
  const safeAsks = Array.isArray(asks) ? asks : [];

  // Debug log
  // console.log('[OrderBook]', { bidsLen: safeBids.length, asksLen: safeAsks.length, currentPrice });

  // Only display the first 8 levels on each side
  const depth = 8;
  const displayBids = safeBids.slice(0, depth);

  // Asks handling:
  // Server sends asks sorted ascending (best ask first): [100, 101, 102]
  // We want to show (from top to bottom):
  // 102 (idx 2)
  // 101 (idx 1)
  // 100 (idx 0) -- Closest to Mid Price
  //
  // So we take slice(0, depth) -> [100, 101, 102]
  // And we map them.
  // Using flex-col-reverse on the container:
  // The first child (idx 0 -> 100) will be at the BOTTOM.
  // The last child (idx 2 -> 102) will be at the TOP.
  // This is exactly what we want!
  //
  // The previous code did .reverse() which made it [102, 101, 100].
  // Then flex-col-reverse put 102 at BOTTOM and 100 at TOP.
  // That was inverted.
  // So we remove .reverse().

  const displayAsks = safeAsks.slice(0, depth);

  // Determine maximum total for scaling bars.
  // For asks (now standard order), the first element is best ask (smallest total).
  // The last element is deepest ask (largest total).
  const maxTotal = Math.max(
    displayBids.length > 0 ? displayBids[displayBids.length - 1][2] : 0,
    displayAsks.length > 0 ? displayAsks[displayAsks.length - 1][2] * 1.5 : 0,
  ) || 1;

  return (
    <div className="w-full text-xs font-mono bg-zinc-950 p-2 rounded border border-zinc-800">
      <div className="flex justify-between text-zinc-500 mb-1 px-1">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      {/* Asks (sellers) */}
      <div className="flex flex-col-reverse">
        {displayAsks.map(([price, size, total], idx) => (
          <div key={`ask-${idx}`} className="relative flex justify-between px-1 py-0.5 hover:bg-zinc-800">
            {/* Depth bar for asks (red) */}
            <div
              className="absolute right-0 top-0 bottom-0 bg-red-500/10 z-0"
              style={{ width: `${(total / maxTotal) * 100}%` }}
            />
            <span className="text-red-400 z-10">{price.toFixed(2)}</span>
            <span className="text-zinc-300 z-10">{size.toFixed(3)}</span>
            <span className="text-zinc-500 z-10">{total.toFixed(1)}</span>
          </div>
        ))}
      </div>
      {/* Mid price */}
      <div className="text-center py-2 text-lg font-bold text-white border-y border-zinc-800 my-1">
        {currentPrice > 0 ? currentPrice.toFixed(2) : 'N/A'}
      </div>
      {/* Bids (buyers) */}
      <div>
        {displayBids.map(([price, size, total], idx) => (
          <div key={`bid-${idx}`} className="relative flex justify-between px-1 py-0.5 hover:bg-zinc-800">
            {/* Depth bar for bids (green) */}
            <div
              className="absolute right-0 top-0 bottom-0 bg-green-500/10 z-0"
              style={{ width: `${(total / maxTotal) * 100}%` }}
            />
            <span className="text-green-400 z-10">{price.toFixed(2)}</span>
            <span className="text-zinc-300 z-10">{size.toFixed(3)}</span>
            <span className="text-zinc-500 z-10">{total.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default OrderBook;