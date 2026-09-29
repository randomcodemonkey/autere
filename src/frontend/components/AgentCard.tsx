import React from 'react';
import { useCardState } from '../hooks/useCardState';
import { PersonaSection } from './Personas';
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
  /** Active model's provider — Usage card shows AIC for copilot providers */
  modelProvider?: string | null;
  extensions: ExtensionInfo[];
  /** Persona bound to the active session */
  persona: { id: string; name: string } | null | undefined;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compacting?: boolean;
  onAbort?: () => void;
  isStreaming?: boolean;
}

/**
 * "Agent" card: groups the Model, Extensions and Usage sections
 * into a single card. Each section keeps its own collapse toggle; the
 * Agent header collapses the whole group. Sections render as flat
 * sub-blocks separated by hairlines (see .agent-card styles).
 */
export const AgentCard: React.FC<AgentCardProps> = ({
  messageCount, requestCount, stats,
  modelProvider,
  extensions,
  persona,
  onCompact, compactDisabled, compacting, onAbort, isStreaming,
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

      <PersonaSection persona={persona} />
      <ExtensionsCard extensions={extensions} />
      <UsageCard messageCount={messageCount} requestCount={requestCount} stats={stats} modelProvider={modelProvider} onCompact={onCompact} compactDisabled={compactDisabled} compacting={compacting} onAbort={onAbort} isStreaming={isStreaming} />
    </div>
  );
};
