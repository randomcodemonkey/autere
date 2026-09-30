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
  /** Active model's provider — 'github-copilot' renders cost as AI Credits (AIC) */
  modelProvider?: string | null;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compacting?: boolean;
  /** Abort the running operation — shown in the Usage card */
  onAbort?: () => void;
  /** Abort a running compaction — shown in the Usage card while compacting */
  onAbortCompaction?: () => void;
  isStreaming?: boolean;
}

export const UsageCard: React.FC<UsageCardProps> = ({ messageCount, requestCount, stats, modelProvider, onCompact, compactDisabled, compacting, onAbort, onAbortCompaction, isStreaming }) => {
  const { collapsed, toggle } = useCardState('usage');
  // GitHub Copilot: pi's $ cost is the list-price estimate — copilot billing
  // is AI Credits (1 credit = $0.01), so show credits (AIC) instead of $.
  const isCopilotProvider = (modelProvider || '').toLowerCase().includes('copilot');
  const [showCostInfo, setShowCostInfo] = useState(false);

  const ctxTokens = stats.contextUsage?.tokens || 0;
  const ctxTotal = stats.contextUsage?.contextWindow || 0;
  // With a reserve-% policy the usable window is smaller than the model's —
  // usage and percentages are shown against the effective window.
  const ctxWindow = stats.contextUsage?.effectiveWindow || ctxTotal;
  const ctxPct = ctxTotal > 0 && ctxWindow !== ctxTotal
    ? Math.min(100, (ctxTokens / ctxWindow) * 100)
    : (stats.contextUsage?.percent || 0);

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
            {isCopilotProvider ? (
              <>
                Usage <span className="est-flag">(AIC)</span>
                <span
                  className="info-icon"
                  role="button"
                  tabIndex={0}
                  title="GitHub Copilot AI Credits — 1 credit = $0.01, converted from the estimated cost. Not the official GitHub billing total (see the Copilot Credit Usage extension for that)."
                  onClick={(e) => { e.stopPropagation(); setShowCostInfo((v) => !v); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowCostInfo((v) => !v); } }}
                >ⓘ</span>
              </>
            ) : (
              <>
            Cost <span className="est-flag">(estimated)</span>
            <span
              className="info-icon"
              role="button"
              tabIndex={0}
              title="Estimated at configurable list-price rates (Settings → Usage), computed from token counts. Not an actual bill — free-tier routing may cost nothing."
              onClick={(e) => { e.stopPropagation(); setShowCostInfo((v) => !v); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowCostInfo((v) => !v); } }}
            >ⓘ</span>
              </>
            )}
          </div>
          <div className="stat-value-compact">
            {isCopilotProvider ? `${(stats.cost / 0.01).toLocaleString(undefined, { maximumFractionDigits: 0 })} AIC` : `$${stats.cost.toFixed(2)}`}
          </div>
          {showCostInfo && (
            <div className="stat-sub" style={{ fontSize: '0.6rem', opacity: 0.7, marginTop: '0.2rem' }}>
              {isCopilotProvider
                ? 'GitHub AI Credits from token-count cost estimates (1 credit = $0.01). See the Copilot Credit Usage extension for an official breakdown.'
                : 'Estimated from token counts at configurable list-price rates (Settings → Usage). Not actual billing.'}
            </div>
          )}
        </div>
        <div>
          <div className="stat-label">Context</div>
          <div className="context-info">
            {ctxTotal > 0
              ? `${formatNumber(ctxTokens)} / ${formatNumber(ctxWindow)}${ctxWindow !== ctxTotal ? ` (${formatNumber(ctxTotal)})` : ''}`
              : '-'}
          </div>
        </div>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${ctxPct}%` }} />
      </div>
      {(onCompact || (compacting && onAbortCompaction)) && (
        <div className="usage-compact-row">
          {onCompact && (
            <button className="btn btn-compact" onClick={onCompact} disabled={compactDisabled}>
              {compacting ? '⏳ Compacting…' : '🗜 Compact Context'}
            </button>
          )}
          {compacting && onAbortCompaction && (
            <button
              className="btn btn-abort session-abort-compaction"
              onClick={() => { if (window.confirm('Abort the compaction? Progress is discarded; the session stays as it was.')) onAbortCompaction(); }}
            >
              ⏹ Abort Compaction
            </button>
          )}
          {onAbort && (
            <button
              className="btn btn-abort"
              style={{ display: isStreaming ? 'block' : 'none' }}
              onClick={onAbort}
            >
              ⏹ Abort Operation
            </button>
          )}
        </div>
      )}
    </div>
  );
};
