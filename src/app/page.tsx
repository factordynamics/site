'use client';

import type { CSSProperties } from 'react';
import Image from 'next/image';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Order = {
  id: string;
  side: 'BUY' | 'SELL';
  symbol: string;
  price: number;
  size: number;
  factor: string;
};

type Highlight = {
  orderIndex: number;
  label: string;
  detail: string;
  position: 'left-top' | 'left-bottom' | 'right-top' | 'right-bottom';
};

type Snapshot = {
  id: string;
  timestamp: string;
  orders: Order[];
  highlights: Highlight[];
};

type RowMetric = {
  centerY: number;
  leftAnchor: number;
  rightAnchor: number;
};

const ORDER_SNAPSHOTS: Snapshot[] = [
  {
    id: 'grid-alpha',
    timestamp: '14:03:18 EST',
    orders: [
      {
        id: 'ob-01',
        side: 'BUY',
        symbol: 'NQH4',
        price: 18943.25,
        size: 12,
        factor: 'Volatility compression'
      },
      {
        id: 'ob-02',
        side: 'SELL',
        symbol: 'CLJ4',
        price: 77.18,
        size: 35,
        factor: 'Term-structure skew'
      },
      {
        id: 'ob-03',
        side: 'SELL',
        symbol: 'ZB',
        price: 120.156,
        size: 22,
        factor: 'Macro carry unwind'
      },
      {
        id: 'ob-04',
        side: 'BUY',
        symbol: 'RTY',
        price: 1956.8,
        size: 18,
        factor: 'Reshoring growth impulse'
      },
      {
        id: 'ob-05',
        side: 'BUY',
        symbol: 'EURUSD',
        price: 1.0831,
        size: 5,
        factor: 'Flow imbalance'
      },
      {
        id: 'ob-06',
        side: 'SELL',
        symbol: 'GC',
        price: 2145.2,
        size: 9,
        factor: 'Haven rotation'
      }
    ],
    highlights: [
      {
        orderIndex: 0,
        label: 'Latency hedge',
        detail: 'Spike damped by compression factor.',
        position: 'left-top'
      },
      {
        orderIndex: 3,
        label: 'Mid-cap uplift',
        detail: 'Domestic reshoring basket.',
        position: 'right-top'
      },
      {
        orderIndex: 5,
        label: 'Flight rotation',
        detail: 'Haven bleed-off detected.',
        position: 'right-bottom'
      }
    ]
  },
  {
    id: 'grid-beta',
    timestamp: '14:03:24 EST',
    orders: [
      {
        id: 'ob-07',
        side: 'SELL',
        symbol: 'NQH4',
        price: 18940.75,
        size: 10,
        factor: 'Dealer gamma reset'
      },
      {
        id: 'ob-08',
        side: 'BUY',
        symbol: 'ZN',
        price: 110.203,
        size: 27,
        factor: 'Rate volatility cushion'
      },
      {
        id: 'ob-09',
        side: 'BUY',
        symbol: 'CLJ4',
        price: 77.05,
        size: 42,
        factor: 'Time-spread inversion'
      },
      {
        id: 'ob-10',
        side: 'SELL',
        symbol: 'RTY',
        price: 1954.6,
        size: 15,
        factor: 'Small-cap fatigue'
      },
      {
        id: 'ob-11',
        side: 'BUY',
        symbol: 'SI',
        price: 24.38,
        size: 31,
        factor: 'Energy beta bleed'
      },
      {
        id: 'ob-12',
        side: 'SELL',
        symbol: 'EURUSD',
        price: 1.0825,
        size: 8,
        factor: 'Dollar funding pulse'
      }
    ],
    highlights: [
      {
        orderIndex: 1,
        label: 'Duration shield',
        detail: 'Rates cushion engages at 18bp.',
        position: 'left-top'
      },
      {
        orderIndex: 2,
        label: 'Crude inversion',
        detail: 'Factor spread crosses signal band.',
        position: 'right-top'
      },
      {
        orderIndex: 5,
        label: 'Funding pulse',
        detail: 'Dollar squeeze in motion.',
        position: 'left-bottom'
      }
    ]
  },
  {
    id: 'grid-gamma',
    timestamp: '14:03:30 EST',
    orders: [
      {
        id: 'ob-13',
        side: 'BUY',
        symbol: 'ES',
        price: 5211.5,
        size: 14,
        factor: 'Earnings drift capture'
      },
      {
        id: 'ob-14',
        side: 'SELL',
        symbol: 'SI',
        price: 24.29,
        size: 26,
        factor: 'Cross-metal arb'
      },
      {
        id: 'ob-15',
        side: 'SELL',
        symbol: 'GC',
        price: 2141.6,
        size: 7,
        factor: 'Mean reversion coil'
      },
      {
        id: 'ob-16',
        side: 'BUY',
        symbol: 'ZN',
        price: 110.245,
        size: 30,
        factor: 'Curve dislocation'
      },
      {
        id: 'ob-17',
        side: 'SELL',
        symbol: 'RTY',
        price: 1950.9,
        size: 12,
        factor: 'Liquidity drought'
      },
      {
        id: 'ob-18',
        side: 'BUY',
        symbol: 'GBPUSD',
        price: 1.2664,
        size: 6,
        factor: 'Carry-momentum mix'
      }
    ],
    highlights: [
      {
        orderIndex: 0,
        label: 'Drift capture',
        detail: 'Earnings factor flips positive.',
        position: 'left-top'
      },
      {
        orderIndex: 3,
        label: 'Curve rescue',
        detail: 'Dislocation > 1.5σ.',
        position: 'left-bottom'
      },
      {
        orderIndex: 4,
        label: 'Liquidity drought',
        detail: 'RTY depth < 20 lots.',
        position: 'right-bottom'
      }
    ]
  }
];

const TICKER_ITEMS = [
  'Factor telemetry online',
  'Order book synced',
  'Latency hedger < 24ms',
  '14 live factor stacks'
];

const ORDER_HEADERS = ['SIDE', 'SYMBOL', 'SIZE', 'PRICE', 'FACTOR'];

export default function HomePage() {
  const [snapshotIndex, setSnapshotIndex] = useState(0);
  const [highlightCycle, setHighlightCycle] = useState(0);
  const [rowMetrics, setRowMetrics] = useState<(RowMetric | null)[]>([]);
  const [displayTime, setDisplayTime] = useState(() => formatClock(new Date()));
  const stackRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSnapshotIndex((previous) => (previous + 1) % ORDER_SNAPSHOTS.length);
      setHighlightCycle((previous) => previous + 1);
    }, 5200);

    return () => clearInterval(interval);
  }, []);

  const snapshot = ORDER_SNAPSHOTS[snapshotIndex];

  useLayoutEffect(() => {
    const updateRowMetrics = () => {
      const container = stackRef.current;

      if (!container) {
        setRowMetrics([]);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const metrics = snapshot.orders.map((_, index) => {
        const rowEl = rowRefs.current[index];
        if (!rowEl) {
          return null;
        }

        const rowRect = rowEl.getBoundingClientRect();
        return {
          centerY: rowRect.top + rowRect.height / 2 - containerRect.top,
          leftAnchor: rowRect.left - containerRect.left,
          rightAnchor: rowRect.right - containerRect.left
        };
      });

      setRowMetrics(metrics);
    };

    updateRowMetrics();
    window.addEventListener('resize', updateRowMetrics);

    return () => {
      window.removeEventListener('resize', updateRowMetrics);
    };
  }, [snapshot]);

  useEffect(() => {
    const timer = setInterval(() => {
      setDisplayTime(formatClock(new Date()));
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <main className="hero">
      <nav className="hero-nav">
        <div className="brand">
          <div className="brand-mark">
            <Image src="/logos/fd-logo.png" alt="Factor Dynamics Logo" width={40} height={40} priority />
          </div>
          <div className="brand-label">
            <span>Factor Dynamics</span>
            <small>Signal console</small>
          </div>
        </div>
        <div className="hero-status">
          <span className="hero-status__dot" />
          <div className="hero-status__copy">
            <span>live factor routing</span>
            <small>[EXPERIMENTAL]</small>
          </div>
        </div>
      </nav>

      <section className="scene">
        <div className="computer-stack" ref={stackRef}>
          <div className="computer">
            <div className="computer__bezel">
              <div className="screen">
                <header className="screen__header">
                  <span>Order book</span>
                  <span>{displayTime}</span>
                </header>

                <div className="order-book">
                  <div className="order-book__labels">
                    {ORDER_HEADERS.map((header) => (
                      <span key={header}>{header}</span>
                    ))}
                  </div>

                  <div className="order-book__rows">
                    {snapshot.orders.map((order, index) => (
                      <div
                        key={order.id}
                        ref={(node) => {
                          rowRefs.current[index] = node;
                        }}
                        className={`order-book__row order-book__row--${order.side.toLowerCase()}`}
                      >
                        <span className="order-book__side">
                          <em />
                          {order.side}
                        </span>
                        <span>{order.symbol}</span>
                        <span>{order.size.toLocaleString('en-US')}</span>
                        <span>{formatPrice(order.price)}</span>
                        <span className="order-book__factor">{order.factor}</span>
                      </div>
                    ))}
                  </div>

                </div>
              </div>
            </div>
            <div className="computer__base">
              <div className="computer__vent" />
              <div className="computer__vent" />
              <div className="computer__vent" />
            </div>
          </div>
          <div className="computer-shadow" />
          <div className="annotation-layer" key={highlightCycle}>
            {snapshot.highlights.map((highlight, index) => {
              const order = snapshot.orders[highlight.orderIndex];
              const metric = rowMetrics[highlight.orderIndex];

              if (!order) {
                return null;
              }

              const isLeft = highlight.position.startsWith('left');
              const anchor = metric
                ? isLeft
                  ? metric.leftAnchor
                  : metric.rightAnchor
                : undefined;

              const annotationStyle: CSSProperties = {
                top: metric ? `${metric.centerY}px` : '50%',
                left: typeof anchor === 'number' ? `${anchor}px` : '50%'
              };

              return (
                <div
                  key={`${snapshot.id}-${highlight.position}-${index}`}
                  className={`annotation annotation--${highlight.position}`}
                  style={annotationStyle}
                >
                  <span className="annotation__line" />
                  <div className="annotation__body">
                    <p className="annotation__label">{highlight.label}</p>
                    <p className="annotation__value">
                      {order.side} {order.size.toLocaleString('en-US')} {order.symbol}
                    </p>
                    <p className="annotation__factor">{highlight.detail}</p>
                    <p className="annotation__factor annotation__factor--accent">{order.factor}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="ticker">
        <div className="ticker__mask">
          <div className="ticker__track">
            {[0, 1].map((groupIndex) => (
              <div key={`ticker-group-${groupIndex}`} className="ticker__group">
                {TICKER_ITEMS.map((item, index) => (
                  <span key={`ticker-item-${groupIndex}-${index}`}>{item}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}

function formatClock(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

function formatPrice(value: number) {
  if (value < 100) {
    return value.toFixed(3);
  }

  if (value < 1000) {
    return value.toFixed(2);
  }

  return value.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  });
}
