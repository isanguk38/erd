import { memo } from 'react';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import { indexLabel, type Table } from '@erd/core';
import type { ViewMode } from '../store';
import { Icon } from './ui';

export type TableNodeData = {
  table: Table;
  fkIds: string[];
  viewMode: ViewMode;
  /** 비교 화면에서 쓰는 강조 표시 */
  highlight?: 'added' | 'changed' | 'removed';
  /** 이 테이블을 선택한 다른 사람들 */
  peers?: { name: string; color: string }[];
  /** 검색 중: 맞는 테이블(match) / 아닌 테이블(dim) */
  search?: 'match' | 'dim';
  matchColumnIds?: string[];
  /** 검색 결과에서 고른 컬럼 ('*'이면 테이블 전체) */
  focusColumnId?: string;
  /** 다른 사람·AI가 방금 바꾼 곳 (잠깐 강조) */
  remote?: { added: boolean; columnIds: string[] };
  /** 열린 댓글 (review = 확인 요청) */
  comments?: { open: number; review: number; columnIds: Set<string> };
  /** 비교 화면: 컬럼별 추가/변경/삭제 표시 */
  columnMarks?: Record<string, 'added' | 'changed' | 'removed'>;
};
export type TableNodeType = Node<TableNodeData, 'table'>;

function TableNodeView({ id, data, selected }: NodeProps<TableNodeType>) {
  const { table, fkIds, viewMode, highlight, peers = [], columnMarks, search, matchColumnIds, focusColumnId, remote, comments } = data;
  const matched = new Set(matchColumnIds ?? []);
  const remoteCols = new Set(remote?.columnIds ?? []);
  const connection = useConnection();
  const isTarget = connection.inProgress && connection.fromNode.id !== id;
  const fk = new Set(fkIds);
  const title = viewMode === 'logical' ? table.logicalName || table.name : table.name;
  const subtitle = viewMode === 'both' && table.logicalName ? table.logicalName : '';

  return (
    <div
      className={`table-node${selected ? ' selected' : ''}${highlight ? ` hl-${highlight}` : ''}${search ? ` search-${search}` : ''}${focusColumnId === '*' ? ' search-focus' : ''}${remote ? ' remote-changed' : ''}`}
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
        {highlight && <span className={`hl-tag hl-tag-${highlight}`}>{{ added: '추가', changed: '변경', removed: '삭제' }[highlight]}</span>}
        <span className="table-node__title">{title}</span>
        {comments && comments.open > 0 && (
          <span className={`comment-badge${comments.review ? ' review' : ''}`} title={`열린 댓글 ${comments.open}개${comments.review ? ` (확인 요청 ${comments.review})` : ''}`}>
            <Icon name="comment" size={11} /> {comments.open}
          </span>
        )}
        {subtitle && <span className="table-node__subtitle">{subtitle}</span>}
      </div>
      <div className="table-node__columns">
        {table.columns.length === 0 && <div className="table-node__empty">컬럼 없음</div>}
        {table.columns.map((c) => {
          const name = viewMode === 'logical' ? c.logicalName || c.name : c.name;
          return (
            <div
              key={c.id}
              className={`table-node__column${c.primaryKey ? ' pk' : ''}${columnMarks?.[c.id] ? ` col-${columnMarks[c.id]}` : ''}${matched.has(c.id) ? ' col-match' : ''}${focusColumnId === c.id ? ' col-focus' : ''}${remoteCols.has(c.id) ? ' col-remote' : ''}${comments?.columnIds.has(c.id) ? ' col-comment' : ''}`}
            >
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
              <span title={indexLabel(table, i)}>{indexLabel(table, i)}</span>
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
