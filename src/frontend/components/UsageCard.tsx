import React, { useState } from 'react';
import { useCardState } from '../hooks/useCardState';
import type { SessionStats } from '../types';

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

interface UsageCardProps {
  messageCount: number;
  requestCount: number;
  stats: SessionStats;
}

export const UsageCard: React.FC<UsageCardProps> = ({ messageCount, requestCount, stats }) => {
  const { collapsed, toggle } = useCardState('usage');
  const [showCostInfo, setShowCostInfo] = useState(false);

  const ctxTokens = stats.contextUsage?.tokens || 0;
  const ctxWindow = stats.contextUsage?.contextWindow || 0;
  const ctxPct = stats.contextUsage?.percent || 0;

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">Usage (session)</div>
        {collapsed && ctxWindow > 0 && (
          <div className="usage-header-bar" title={`Context ${Math.round(ctxPct)}%`}>
            <div className="usage-header-bar-fill" style={{ width: `${ctxPct}%` }} />
          </div>
        )}
        <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      <div className="usage-grid">
        <div>
          <div className="stat-label">Messages</div>
          <div className="stat-value-compact">{messageCount}</div>
        </div>
        <div>
          <div className="stat-label">Requests</div>
          <div className="stat-value-compact">{requestCount}</div>
        </div>
        <div>
          <div className="stat-label">Input Tokens</div>
          <div className="stat-value-compact" title={`plus ${formatNumber(stats.tokens.cacheRead || 0)} cache-read tokens`}>
            {formatNumber(stats.tokens.input)}
          </div>
          {stats.tokens.input > 0 && (
            <div className="stat-cache-sub">+ {formatNumber(stats.tokens.cacheRead || 0)} cache-read</div>
          )}
        </div>
        <div>
          <div className="stat-label">Output Tokens</div>
          <div className="stat-value-compact">{formatNumber(stats.tokens.output)}</div>
        </div>
        <div>
          <div className="stat-label">
            Cost <span className="est-flag">(estimated)</span>
            <span
              className="info-icon"
              role="button"
              tabIndex={0}
              title="Estimated at configurable list-price rates (Settings → Usage), computed from token counts. Not an actual bill — free-tier routing may cost nothing."
              onClick={(e) => { e.stopPropagation(); setShowCostInfo((v) => !v); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowCostInfo((v) => !v); } }}
            >ⓘ</span>
          </div>
          <div className="stat-value-compact">${stats.cost.toFixed(2)}</div>
          {showCostInfo && (
            <div className="stat-sub" style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '0.2rem' }}>
              Estimated from token counts at configurable list-price rates (Settings → Usage). Not actual billing.
            </div>
          )}
        </div>
        <div>
          <div className="stat-label">Context</div>
          <div className="context-info">
            {ctxWindow > 0 ? `${formatNumber(ctxTokens)} / ${formatNumber(ctxWindow)}` : '-'}
          </div>
        </div>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${ctxPct}%` }} />
      </div>
    </div>
  );
};
