import React, { useEffect, useCallback, useRef } from 'react';
import { useCardState } from '../hooks/useCardState';
import { url } from '../base-path';
import type { AvailableModel } from '../types';

interface ModelCardProps {
  models: AvailableModel[];
  activeModelId: string | null;
  onModelsFetched?: (models: AvailableModel[]) => void;
}

export const ModelCard: React.FC<ModelCardProps> = ({ models, activeModelId, onModelsFetched }) => {
  const { collapsed, toggle } = useCardState('model');
  const fetchedRef = useRef(false);

  // Fetch models from HTTP endpoint if list is empty (fallback for SSE timing)
  useEffect(() => {
    if (models.length > 0 || fetchedRef.current) return;
    fetchedRef.current = true;
    fetch(url('/api/models'))
      .then(res => res.json())
      .then(data => {
        if (data.success && data.data?.length > 0) {
          onModelsFetched?.(data.data);
        }
      })
      .catch(() => {});
  }, [models.length, onModelsFetched]);

  const selectModel = async (provider: string, modelId: string) => {
    try {
      const res = await fetch(url('/api/set-model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId }),
      });
      const data = await res.json();
      if (!data.success) console.error('Failed to set model:', data.error);
    } catch (err) {
      console.error('Set model error:', err);
    }
  };

  return (
    <div className={`card${collapsed ? ' collapsed' : ''}`}>
      <div className="card-header" onClick={toggle}>
        <div className="card-title">Model</div>
        <button className="card-toggle" title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      <div className="model-list">
        {!models || models.length === 0 ? (
          <div className="model-empty">No scoped models configured</div>
        ) : (
          models.map((model) => (
            <div
              key={`${model.provider}/${model.id}`}
              className={`model-item${model.id === activeModelId ? ' active' : ''}`}
              onClick={() => selectModel(model.provider, model.id)}
            >
              <span className="model-dot" />
              <span className="model-name">{model.name || model.id}</span>
              <span className="model-provider">{model.provider}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
