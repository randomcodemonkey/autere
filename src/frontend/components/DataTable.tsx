import React from 'react';

export interface DataColumn {
  key: string;
  label: string;
  className?: string;
}

/**
 * Shared tabular-data table (Users, Tasks, tokens, Models catalog, …).
 * Columns define both the header and the mobile card labels — every data
 * cell must carry data-label={column label} (use <TD>) so the responsive
 * card layout can render field names. The wrapper scrolls internally
 * when content doesn't fit (.table-responsive) and collapses rows into
 * labeled cards on mobile (styles.scss).
 */
export const DataTable: React.FC<{ columns: DataColumn[]; className?: string; children: React.ReactNode }> = ({ columns, className, children }) => (
  <div className="table-responsive">
    <table className={`data-table${className ? ` ${className}` : ''}`}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={c.className}>{c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

/** Data cell — carries the column label for the mobile card layout. */
export const TD: React.FC<{ label?: string; className?: string; colSpan?: number; children: React.ReactNode }> = ({ label, className, colSpan, children }) => (
  <td data-label={label} colSpan={colSpan} className={className}>{children}</td>
);
