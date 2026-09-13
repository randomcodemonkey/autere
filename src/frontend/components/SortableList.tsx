import React, { useState, useCallback, useRef } from 'react';

interface SortableListProps {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  disabled?: boolean;
}

const LONG_PRESS_MS = 300;

export function SortableList({
  items,
  onChange,
  placeholder = 'Enter value…',
  addLabel = 'Add',
  disabled = false,
}: SortableListProps) {
  const [newItem, setNewItem] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Desktop drag
  const handleDragStart = useCallback((_e: React.DragEvent, index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragEnter = useCallback((_e: React.DragEvent, index: number) => {
    setOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const updated = [...items];
      const [removed] = updated.splice(dragIndex, 1);
      updated.splice(overIndex, 0, removed);
      onChange(updated);
    }
    setDragIndex(null);
    setOverIndex(null);
  }, [dragIndex, overIndex, items, onChange]);

  // Mobile touch drag
  const touchState = useRef<{ index: number; startY: number; timer: ReturnType<typeof setTimeout> | null }>({ index: -1, startY: 0, timer: null });
  const [touchDragging, setTouchDragging] = useState(false);

  const handleTouchStart = useCallback((e: React.TouchEvent, index: number) => {
    const y = e.touches[0].clientY;
    touchState.current = {
      index,
      startY: y,
      timer: setTimeout(() => {
        setTouchDragging(true);
        setDragIndex(index);
      }, LONG_PRESS_MS),
    };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchDragging || dragIndex === null) return;

    const y = e.touches[0].clientY;
    const listEl = (e.target as HTMLElement).closest('.sortable-list');
    if (!listEl) return;

    const itemEls = listEl.querySelectorAll('.sortable-list-item');
    let newOver = dragIndex;
    for (let i = 0; i < itemEls.length; i++) {
      const rect = itemEls[i].getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        newOver = i;
        break;
      }
    }
    setOverIndex(newOver);
  }, [touchDragging, dragIndex]);

  const handleTouchEnd = useCallback(() => {
    if (touchState.current.timer) {
      clearTimeout(touchState.current.timer);
      touchState.current.timer = null;
    }

    if (touchDragging && dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const updated = [...items];
      const [removed] = updated.splice(dragIndex, 1);
      updated.splice(overIndex, 0, removed);
      onChange(updated);
    }

    setTouchDragging(false);
    setDragIndex(null);
    setOverIndex(null);
  }, [touchDragging, dragIndex, overIndex, items, onChange]);

  const handleAdd = useCallback(() => {
    const trimmed = newItem.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onChange([...items, trimmed]);
    setNewItem('');
  }, [newItem, items, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    },
    [handleAdd],
  );

  const handleRemove = useCallback(
    (index: number) => {
      onChange(items.filter((_, i) => i !== index));
    },
    [items, onChange],
  );

  const handleEdit = useCallback(
    (index: number, value: string) => {
      const updated = [...items];
      updated[index] = value;
      onChange(updated);
    },
    [items, onChange],
  );

  const getItemClass = (index: number) => {
    let cls = 'sortable-list-item';
    if (dragIndex === index) cls += ' dragging';
    if (overIndex === index) cls += ' drag-over';
    return cls;
  };

  return (
    <div className={`sortable-list${touchDragging ? ' touch-active' : ''}`}>
      {items.map((item, index) => (
        <div
          // Index keys: inputs are fully controlled, so values stay correct
          // through edits and reorders. Keying by content (key={`${item}-${index}`})
          // remounted the row's input on the first keystroke — focus died
          // mid-word and editing was impossible.
          key={index}
          className={getItemClass(index)}
          draggable={!disabled}
          onDragStart={(e) => handleDragStart(e, index)}
          onDragEnter={(e) => handleDragEnter(e, index)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => e.preventDefault()}
          onTouchStart={(e) => handleTouchStart(e, index)}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <span className="sortable-list-drag-handle" title="Drag to reorder">⠿</span>
          <input
            className="sortable-list-input"
            type="text"
            value={item}
            onChange={(e) => handleEdit(index, e.target.value)}
            disabled={disabled}
          />
          <button
            className="sortable-list-remove"
            onClick={() => handleRemove(index)}
            disabled={disabled}
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="sortable-list-add">
        <input
          className="sortable-list-input"
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
        <button
          className="btn btn-primary sortable-list-add-btn"
          onClick={handleAdd}
          disabled={disabled || !newItem.trim()}
          type="button"
        >
          {addLabel}
        </button>
      </div>
    </div>
  );
}
