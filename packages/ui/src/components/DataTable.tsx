import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { EmptyState, ErrorState, SkeletonTable, type EmptyStateProps } from './feedback.js';

/**
 * Table with the four mandatory states built in: loading, empty, error and
 * success (design principle 3). Pages never have to reimplement them.
 */

export interface Column<T> {
  id: string;
  header: string;
  /** Cell renderer. Keep it presentational; the page owns the data. */
  cell: (row: T) => ReactNode;
  /** Value used for client-side sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  width?: string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  loading?: boolean;
  error?: { message: string; detail?: string } | null;
  onRetry?: () => void;
  empty?: EmptyStateProps;
  onRowClick?: (row: T) => void;
  /** Trailing actions cell, rendered right aligned. */
  rowActions?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  error = null,
  onRetry,
  empty,
  onRowClick,
  rowActions,
}: DataTableProps<T>): JSX.Element {
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.id === sort.column);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [rows, sort, columns]);

  if (loading) return <SkeletonTable columns={columns.length} />;
  if (error) {
    return <ErrorState message={error.message} {...(error.detail ? { detail: error.detail } : {})} {...(onRetry ? { onRetry } : {})} />;
  }
  if (rows.length === 0) {
    return <EmptyState {...(empty ?? { title: 'Nothing here yet' })} />;
  }

  const toggleSort = (columnId: string): void => {
    setSort((current) =>
      current?.column === columnId
        ? { column: columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column: columnId, direction: 'asc' },
    );
  };

  return (
    <div className="scp-table-wrap">
      <table className="scp-table">
        {caption ? <caption className="scp-visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={{
                  width: column.width,
                  textAlign: column.align === 'right' ? 'right' : 'left',
                }}
                aria-sort={
                  sort?.column === column.id
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
              >
                {column.sortValue ? (
                  <button type="button" className="scp-table-sort" onClick={() => toggleSort(column.id)}>
                    {column.header}
                    <Icon
                      name="chevronDown"
                      size={14}
                      style={{
                        opacity: sort?.column === column.id ? 1 : 0.35,
                        transform: sort?.column === column.id && sort.direction === 'desc' ? 'rotate(180deg)' : undefined,
                      }}
                    />
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
            {rowActions ? (
              <th scope="col" className="scp-table-actions">
                <span className="scp-visually-hidden">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowClick ? 'true' : 'false'}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((column) => (
                <td key={column.id} style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}>
                  {column.cell(row)}
                </td>
              ))}
              {rowActions ? (
                <td className="scp-table-actions" onClick={(event) => event.stopPropagation()}>
                  <div className="scp-row" style={{ justifyContent: 'flex-end' }}>
                    {rowActions(row)}
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
