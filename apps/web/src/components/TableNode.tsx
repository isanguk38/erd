import { memo } from 'react';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import type { Table } from '@erd/core';
import type { ViewMode } from '../store';

export type TableNodeData = {
  table: Table;
  fkIds: string[];
  viewMode: ViewMode;
  /** 비교 화면에서 쓰는 강조 표시 */
  highlight?: 'added' | 'changed' | 'removed';
  /** 이 테이블을 선택한 다른 사람들 */
  peers?: { name: string; color: string }[];
};
export type TableNodeType = Node<TableNodeData, 'table'>;

function TableNodeView({ id, data, selected }: NodeProps<TableNodeType>) {
  const { table, fkIds, viewMode, highlight, peers = [] } = data;
  const connection = useConnection();
  const isTarget = connection.inProgress && connection.fromNode.id !== id;
  const fk = new Set(fkIds);
  const title = viewMode === 'logical' ? table.logicalName || table.name : table.name;
  const subtitle = viewMode === 'both' && table.logicalName ? table.logicalName : '';

  return (
    <div
      className={`table-node${selected ? ' selected' : ''}${highlight ? ` hl-${highlight}` : ''}`}
      style={{
        ['--table-color' as string]: table.color || 'var(--accent)',
        ...(peers.length ? { outline: `2px solid ${peers[0].color}`, outlineOffset: 3 } : {}),
      }}
    >
      {peers.length > 0 && (
        <div className="peer-tags">
          {peers.map((p) => (
            <span key={p.name + p.color} style={{ background: p.color }}>{p.name}</span>
          ))}
        </div>
      )}
      <div className="table-node__header">
        <span className="table-node__title">{title}</span>
        {subtitle && <span className="table-node__subtitle">{subtitle}</span>}
      </div>
      <div className="table-node__columns">
        {table.columns.length === 0 && <div className="table-node__empty">컬럼 없음</div>}
        {table.columns.map((c) => {
          const name = viewMode === 'logical' ? c.logicalName || c.name : c.name;
          return (
            <div key={c.id} className={`table-node__column${c.primaryKey ? ' pk' : ''}`}>
              <span className="table-node__key">
                {c.primaryKey && <span className="badge badge-pk" title="기본키">PK</span>}
                {fk.has(c.id) && <span className="badge badge-fk" title="외래키">FK</span>}
                {c.unique && !c.primaryKey && <span className="badge badge-ix" title="UNIQUE">UQ</span>}
              </span>
              <span className="table-node__name">
                {name}
                {viewMode === 'both' && c.logicalName && <span className="table-node__logical">{c.logicalName}</span>}
              </span>
              <span className="table-node__type">
                {c.type}
                {c.length ? `(${c.length})` : ''}
              </span>
              <span className="table-node__nn" title={c.nullable && !c.primaryKey ? 'NULL 허용' : 'NOT NULL'}>
                {c.nullable && !c.primaryKey ? '' : 'NN'}
              </span>
            </div>
          );
        })}
      </div>
      {table.indexes.length > 0 && (
        <div className="table-node__indexes">
          {table.indexes.map((i) => (
            <div key={i.id} className="table-node__index">
              <span className="badge badge-ix">{i.unique ? 'UQ' : 'IX'}</span>
              {i.columnIds.map((cid) => table.columns.find((c) => c.id === cid)?.name ?? '?').join(', ')}
            </div>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="table-node__source" title="끌어서 다른 테이블에 놓으면 관계가 만들어집니다" />
      <Handle type="target" position={Position.Left} className={`table-node__target${isTarget ? ' active' : ''}`} isConnectableStart={false} />
    </div>
  );
}

export const TableNode = memo(TableNodeView);
