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
  const [expandedCmds, setExpandedCmds] = useState<Set<string>>(new Set());

  const toggleCmd = (key: string) => {
    setExpandedCmds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const recentToolsCmds = recentTools.map((t) => formatToolCmd(t.name, t.args));

  const truncateCmd = (cmd: string, isExpanded: boolean): { display: string; truncated: boolean } => {
    if (cmd.length <= 128) return { display: cmd, truncated: false };
    return { display: isExpanded ? cmd : cmd.slice(0, 128) + '…', truncated: true };
  };

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">
          Tools
          {collapsed && activeTools.length > 0 && (
            <span className="badge success">{activeTools.length} active</span>
          )}
          {collapsed && recentTools.length > 0 && (
            <span className="badge">{recentTools.length} recent</span>
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
          activeTools.map((tool) => {
            const { display: displayCmd, truncated } = truncateCmd(tool.cmd || '', expandedCmds.has(tool.id));
            const isExpanded = expandedCmds.has(tool.id) && truncated;
            return (
              <div key={tool.id} className="tool-chip">
                <div className="spinner" />
                {tool.name}
                {tool.cmd && (
                  <div
                    className={`tool-cmd tool-cmd-active${truncated ? ' tool-cmd-truncated' : ''}${isExpanded ? ' expanded' : ''}`}
                    onClick={() => truncated && toggleCmd(tool.id)}
                  >
                    {displayCmd}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      {recentTools.length > 0 && (
        <div className="recent-tools">
          <div className="recent-tools-title">Last {recentTools.length} tools</div>
          {recentTools.map((t, i) => {
            const cmd = recentToolsCmds[i];
            const isExpanded = expandedCmds.has(`r${i}`) && cmd.length > 64;
            const truncated = cmd.length > 64;
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
                      onClick={() => truncated && toggleCmd(`r${i}`)}
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
