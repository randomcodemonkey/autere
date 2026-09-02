import React from 'react';
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

  const ctxTokens = stats.contextUsage?.tokens || 0;
  const ctxWindow = stats.contextUsage?.contextWindow || 0;
  const ctxPct = stats.contextUsage?.percent || 0;

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">Usage</div>
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
          <div className="stat-value-compact">{formatNumber(stats.tokens.input)}</div>
        </div>
        <div>
          <div className="stat-label">Output Tokens</div>
          <div className="stat-value-compact">{formatNumber(stats.tokens.output)}</div>
        </div>
        <div>
          <div className="stat-label">Cost</div>
          <div className="stat-value-compact">${stats.cost.toFixed(4)}</div>
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
