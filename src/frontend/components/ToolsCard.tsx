import React, { useState } from 'react';
import { useCardState } from '../hooks/useCardState';
import type { ActiveTool, RecentTool } from '../types';

function formatToolCmd(name: string, args: any): string {
  if (!args) return '';
  if (name === 'bash' && typeof args.command === 'string') return args.command;
  if (name === 'read' && typeof args.path === 'string') return args.path;
  if (name === 'write' && typeof args.path === 'string') return args.path;
  if (name === 'edit' && typeof args.path === 'string') return args.path;
  if (name === 'find' && typeof args.path === 'string') return args.path;
  if (name === 'ls' && typeof args.path === 'string') return args.path;
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

interface ToolsCardProps {
  activeTools: ActiveTool[];
  recentTools: RecentTool[];
}

export const ToolsCard: React.FC<ToolsCardProps> = ({ activeTools, recentTools }) => {
  const { collapsed, toggle } = useCardState('tools');
  const [expandedCmds, setExpandedCmds] = useState<Set<number>>(new Set());

  const toggleCmd = (idx: number) => {
    setExpandedCmds((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const recentToolsCmds = recentTools.map((t) => formatToolCmd(t.name, t.args));

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">
          Tools
          {collapsed && activeTools.length > 0 && (
            <span className="tool-active-count">{activeTools.length} active</span>
          )}
          {collapsed && recentTools.length > 0 && (
            <span className="tool-recent-count">{recentTools.length} recent</span>
          )}
        </div>
        <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      <div className="tool-list">
        {activeTools.length === 0 ? (
          <span className="tool-empty">No active tools</span>
        ) : (
          activeTools.map((tool) => (
            <div key={tool.id} className="tool-chip">
              <div className="spinner" />
              {tool.name}
              {tool.cmd && (
                <div className="tool-cmd tool-cmd-active">{tool.cmd}</div>
              )}
            </div>
          ))
        )}
      </div>
      {recentTools.length > 0 && (
        <div className="recent-tools">
          <div className="recent-tools-title">Last {recentTools.length} tools</div>
          {recentTools.map((t, i) => {
            const cmd = recentToolsCmds[i];
            const truncated = cmd.length > 64;
            const isExpanded = expandedCmds.has(i) && truncated;
            const displayCmd = truncated && !isExpanded ? cmd.slice(0, 64) + '…' : cmd;
            return (
              <div key={i} className="recent-tool-item">
                <div className="recent-tool-header">
                  <span className={`recent-tool-dot ${t.isError ? 'recent-tool-err' : 'recent-tool-ok'}`} />
                  <span className="recent-tool-name">{t.name}</span>
                </div>
                {cmd && (
                  <div className="recent-tool-cmd-wrap">
                    <div
                      className={`tool-cmd${truncated ? ' tool-cmd-truncated' : ''}${isExpanded ? ' expanded' : ''}`}
                      onClick={() => truncated && toggleCmd(i)}
                    >
                      {displayCmd}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
