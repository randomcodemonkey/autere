import React from 'react';
import { useCardState } from '../hooks/useCardState';
import { ExtensionsCard } from './ExtensionsCard';
import { UsageCard } from './UsageCard';
import type { AvailableModel, ExtensionInfo, SessionStats } from '../types';

interface AgentCardProps {
  models: AvailableModel[];
  activeModelId: string | null;
  onModelsFetched?: (models: AvailableModel[]) => void;
  messageCount: number;
  requestCount: number;
  stats: SessionStats;
  extensions: ExtensionInfo[];
}

/**
 * "Agent" card: groups the Model, Extensions and Usage sections
 * into a single card. Each section keeps its own collapse toggle; the
 * Agent header collapses the whole group. Sections render as flat
 * sub-blocks separated by hairlines (see .agent-card styles).
 */
export const AgentCard: React.FC<AgentCardProps> = ({
  messageCount, requestCount, stats,
  extensions,
}) => {
  const { collapsed, toggle } = useCardState('agent');

  return (
    <div className={`card agent-card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">Agent</div>
        <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>

      <ExtensionsCard extensions={extensions} />
      <UsageCard messageCount={messageCount} requestCount={requestCount} stats={stats} />
    </div>
  );
};
