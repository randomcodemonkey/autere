import React from 'react';
import { useCardState } from '../hooks/useCardState';
import { ModelCard } from './ModelCard';
import { ExtensionsCard } from './ExtensionsCard';
import { ToolsCard } from './ToolsCard';
import { UsageCard } from './UsageCard';
import type { ActiveTool, AvailableModel, ExtensionInfo, RecentTool, SessionStats } from '../types';

interface AgentCardProps {
  models: AvailableModel[];
  activeModelId: string | null;
  onModelsFetched?: (models: AvailableModel[]) => void;
  messageCount: number;
  requestCount: number;
  stats: SessionStats;
  activeTools: ActiveTool[];
  recentTools: RecentTool[];
  extensions: ExtensionInfo[];
}

/**
 * "Agent" card: groups the Model, Extensions, Tools and Usage sections
 * into a single card. Each section keeps its own collapse toggle; the
 * Agent header collapses the whole group. Sections render as flat
 * sub-blocks separated by hairlines (see .agent-card styles).
 */
export const AgentCard: React.FC<AgentCardProps> = ({
  models, activeModelId, onModelsFetched,
  messageCount, requestCount, stats,
  activeTools, recentTools,
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

      <ModelCard models={models} activeModelId={activeModelId} onModelsFetched={onModelsFetched} />
      <ExtensionsCard extensions={extensions} />
      <ToolsCard activeTools={activeTools} recentTools={recentTools} />
      <UsageCard messageCount={messageCount} requestCount={requestCount} stats={stats} />
    </div>
  );
};
