import { useState } from 'react';
import {
  addColumn,
  addIndex,
  findTable,
  foreignKeyColumnIds,
  getDialect,
  indexName,
  moveColumn,
  relationName,
  removeColumn,
  removeIndex,
  removeRelation,
  removeTable,
  updateColumn,
  updateIndex,
  updateRelation,
  updateTable,
  type Column,
  type ReferentialAction,
  type Relation,
  type Table,
} from '@erd/core';
import { useStore } from '../store';
import { TemplateApplyMenu } from './TemplatePanels';
import { TableComments } from './Comments';
import { useDialect } from '../lib/hooks';

const ACTIONS: ReferentialAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
export const TABLE_COLORS = ['', '#2563eb', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#dc2626', '#9333ea', '#64748b'];

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer');
  let content = <EmptyInspector />;
  if (selection?.type === 'table') {
    const table = findTable(schema, selection.id);
    if (table) content = <TableEditor table={table} />;
  } else if (selection?.type === 'relation') {
    const relation = schema.relations.find((r) => r.id === selection.id);
    if (relation) content = <RelationEditor relation={relation} />;
  }
  // 보기 권한이면 모든 입력을 잠근다
  return readOnly ? <fieldset className="readonly-fieldset" disabled>{content}</fieldset> : content;
}

function EmptyInspector() {
  return (
    <aside className="inspector inspector--empty">
      <h3>사용 방법</h3>
      <ul>
        <li>빈 곳을 <b>더블클릭</b>하면 테이블이 생깁니다.</li>
        <li>테이블을 클릭하면 여기서 컬럼과 인덱스를 편집합니다.</li>
        <li>테이블 오른쪽 점을 끌어 다른 테이블에 놓으면 <b>관계(FK)</b>가 생깁니다. 끌기 시작한 쪽이 부모입니다.</li>
        <li>관계 종류는 상단의 관계 메뉴에서 고릅니다.</li>
        <li><kbd>Delete</kbd> 선택 삭제, <kbd>Ctrl</kbd>+<kbd>Z</kbd> 되돌리기</li>
      </ul>
    </aside>
  );
}

/** 입력 중에는 로컬 값만 바꾸고, 포커스를 잃거나 Enter를 누를 때 저장한다 (되돌리기 기록을 글자마다 남기지 않기 위해). */
function TextInput({ value, onCommit, placeholder, className, list }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; list?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function TableEditor({ table }: { table: Table }) {
  const schema = useStore((s) => s.schema);
  const dialect = getDialect(useDialect());
  const { edit, select } = useStore.getState();
  const fkIds = foreignKeyColumnIds(schema, table.id);
  const setTable = (patch: Parameters<typeof updateTable>[2]) => edit((d) => updateTable(d, table.id, patch));
  const setColumn = (column: Column, patch: Partial<Column>) => edit((d) => updateColumn(d, table.id, column.id, patch));

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <h3>테이블</h3>
        <div className="btn-row">
          <TemplateApplyMenu tableIds={[table.id]} />
          <button
            className="btn btn-danger btn-sm"
            onClick={() => {
              if (!confirm(`${table.name} 테이블을 삭제할까요?`)) return;
              edit((d) => removeTable(d, table.id));
              select(null);
            }}
          >
            삭제
          </button>
        </div>
      </div>
      <div className="form-grid">
        <label>물리명</label>
        <TextInput value={table.name} onCommit={(name) => setTable({ name })} />
        <label>논리명</label>
        <TextInput value={table.logicalName} onCommit={(logicalName) => setTable({ logicalName })} placeholder="예: 회원" />
        <label>설명</label>
        <TextInput value={table.comment} onCommit={(comment) => setTable({ comment })} placeholder="비우면 논리명이 SQL 코멘트가 됩니다" />
        <label>색상</label>
        <div className="colors">
          {TABLE_COLORS.map((c) => (
            <button
              key={c || 'default'}
              className={`color-chip${(table.color ?? '') === c ? ' active' : ''}`}
              style={{ background: c || 'var(--accent)' }}
              title={c ? c : '기본'}
              onClick={() => setTable({ color: c || undefined })}
            />
          ))}
        </div>
      </div>

      <div className="inspector__section">
        <div className="inspector__section-head">
          <h4>컬럼 ({table.columns.length})</h4>
          <button className="btn btn-sm" onClick={() => edit((d) => addColumn(d, table.id))}>+ 컬럼</button>
        </div>
        <datalist id="type-suggestions">
          {dialect.typeSuggestions.map((t) => <option key={t} value={t} />)}
        </datalist>
        <div className="column-grid">
          <div className="column-grid__head">
            <span>물리명</span><span>논리명</span><span>타입</span><span>길이</span>
            <span title="기본키">PK</span><span title="NOT NULL">NN</span><span title="UNIQUE">UQ</span><span title="자동 증가">AI</span>
            <span>기본값</span><span>설명</span><span />
          </div>
          {table.columns.map((c, i) => (
            <div key={c.id} className="column-grid__row">
              <TextInput value={c.name} onCommit={(name) => setColumn(c, { name })} className={fkIds.has(c.id) ? 'is-fk' : ''} />
              <TextInput value={c.logicalName} onCommit={(logicalName) => setColumn(c, { logicalName })} />
              <TextInput value={c.type} list="type-suggestions" onCommit={(type) => setColumn(c, { type: type.toUpperCase() })} />
              <TextInput value={c.length} onCommit={(length) => setColumn(c, { length })} />
              <input type="checkbox" checked={c.primaryKey} onChange={(e) => setColumn(c, { primaryKey: e.target.checked })} />
              <input type="checkbox" checked={!c.nullable || c.primaryKey} disabled={c.primaryKey} onChange={(e) => setColumn(c, { nullable: !e.target.checked })} />
              <input type="checkbox" checked={c.unique} disabled={c.primaryKey} onChange={(e) => setColumn(c, { unique: e.target.checked })} />
              <input type="checkbox" checked={c.autoIncrement} onChange={(e) => setColumn(c, { autoIncrement: e.target.checked })} />
              <span className="default-cell">
                <TextInput value={c.defaultValue ?? ''} placeholder="NULL" onCommit={(v) => setColumn(c, { defaultValue: v.trim() === '' ? null : v })} />
                {/* MySQL·MariaDB 날짜 컬럼: 행이 바뀔 때 현재 시각으로 (ON UPDATE CURRENT_TIMESTAMP) */}
                {(dialect.id === 'mysql' || dialect.id === 'mariadb') && /^(TIMESTAMP|DATETIME)/i.test(c.type) && (
                  <button
                    className={`onupdate-btn${c.onUpdate ? ' on' : ''}`}
                    title={c.onUpdate ? `ON UPDATE ${c.onUpdate} (행이 바뀔 때마다 현재 시각) — 누르면 끕니다` : '행이 바뀔 때마다 현재 시각으로 (ON UPDATE CURRENT_TIMESTAMP)'}
                    onClick={() => setColumn(c, { onUpdate: c.onUpdate ? undefined : /^\d+$/.test(c.length) ? `CURRENT_TIMESTAMP(${c.length})` : 'CURRENT_TIMESTAMP' })}
                  >
                    ↻
                  </button>
                )}
              </span>
              <TextInput value={c.comment} onCommit={(comment) => setColumn(c, { comment })} />
              <span className="row-actions">
                <button className="icon-btn" title="위로" disabled={i === 0} onClick={() => edit((d) => moveColumn(d, table.id, c.id, i - 1))}>↑</button>
                <button className="icon-btn" title="아래로" disabled={i === table.columns.length - 1} onClick={() => edit((d) => moveColumn(d, table.id, c.id, i + 1))}>↓</button>
                <button className="icon-btn danger" title="삭제" onClick={() => edit((d) => removeColumn(d, table.id, c.id))}>×</button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <IndexEditor table={table} />
      <TableComments table={table} />
    </aside>
  );
}

/** 식 인덱스 예시 (DB 종류별 문법) */
const EXPRESSION_EXAMPLE: Record<string, (col: string) => string> = {
  postgresql: (col) => `lower(${col})`,
  mysql: (col) => `(lower(\`${col}\`))`,
  mariadb: (col) => `(lower(\`${col}\`))`,
  oracle: (col) => `UPPER("${col.toUpperCase()}")`,
  mssql: (col) => col,
};
const EXPRESSION_HINT: Record<string, string> = {
  postgresql: "예) lower(email), (metadata ->> 'sitecd'), to_tsvector('simple', body)",
  mysql: '예) (lower(`email`)) — MySQL 8.0.13 이상, 식마다 괄호를 한 번 더 감쌉니다',
  mariadb: 'MariaDB는 식 인덱스를 지원하지 않습니다 (가상 컬럼을 만들어 인덱스를 거세요)',
  oracle: '예) UPPER("EMAIL"), TRUNC("CREATED_AT")',
  mssql: 'SQL Server는 식 인덱스를 지원하지 않습니다 (계산 컬럼을 만들어 인덱스를 거세요)',
};

function IndexEditor({ table }: { table: Table }) {
  const { edit } = useStore.getState();
  const dialectId = useDialect();
  // DB마다 쓸 수 있는 인덱스 방식(PostgreSQL: gin 등, MySQL: fulltext·spatial)과 부분 인덱스(WHERE) 지원
  const support = getDialect(dialectId).indexSupport ?? {};
  const methods = support.methods ?? [];
  const canMethod = methods.length > 0;
  const canWhere = Boolean(support.where);
  return (
    <div className="inspector__section">
      <div className="inspector__section-head">
        <h4>인덱스 ({table.indexes.length})</h4>
        <span className="row-gap">
          <button className="btn btn-sm" disabled={table.columns.length === 0} onClick={() => edit((d) => addIndex(d, table.id, { columnIds: [table.columns[0].id] }))}>
            + 인덱스
          </button>
          <button
            className="btn btn-sm"
            title="컬럼 대신 식(함수)으로 만드는 인덱스. 예) lower(email)"
            disabled={table.columns.length === 0}
            onClick={() => edit((d) => addIndex(d, table.id, { columnIds: [], expression: (EXPRESSION_EXAMPLE[dialectId] ?? EXPRESSION_EXAMPLE.postgresql)(table.columns[0].name) }))}
          >
            + 식 인덱스
          </button>
        </span>
      </div>
      {table.indexes.length === 0 && <p className="muted">조회 조건에 자주 쓰는 컬럼에 인덱스를 추가하세요. 컬럼의 UQ 체크는 UNIQUE 인덱스로 만들어집니다.</p>}
      {table.indexes.map((index) => {
        const isExpression = index.expression !== undefined;
        const showMethod = canMethod || Boolean(index.method);
        const showWhere = canWhere || Boolean(index.where);
        return (
          <div key={index.id} className="index-card">
            <div className="index-card__head">
              <TextInput value={index.name} placeholder={indexName(table, { ...index, name: '' })} onCommit={(name) => edit((d) => updateIndex(d, table.id, index.id, { name }))} />
              <label className="check">
                <input type="checkbox" checked={index.unique} onChange={(e) => edit((d) => updateIndex(d, table.id, index.id, { unique: e.target.checked }))} />
                UNIQUE
              </label>
              <button className="icon-btn danger" title="인덱스 삭제" onClick={() => edit((d) => removeIndex(d, table.id, index.id))}>×</button>
            </div>
            {isExpression ? (
              <div className="index-card__expression">
                <label>
                  <span>식</span>
                  <TextInput
                    className="mono"
                    value={index.expression ?? ''}
                    placeholder={(EXPRESSION_EXAMPLE[dialectId] ?? EXPRESSION_EXAMPLE.postgresql)(table.columns[0]?.name ?? 'name')}
                    onCommit={(expression) => edit((d) => updateIndex(d, table.id, index.id, { expression }))}
                  />
                </label>
                <p className="muted small">{EXPRESSION_HINT[dialectId] ?? EXPRESSION_HINT.postgresql}</p>
              </div>
            ) : (
              <div className="index-card__columns">
                {index.columnIds.map((cid, i) => {
                  const column = table.columns.find((c) => c.id === cid);
                  return (
                    <span key={cid} className="chip">
                      {i + 1}. {column?.name ?? '?'}
                      <button
                        title="빼기"
                        onClick={() => edit((d) => updateIndex(d, table.id, index.id, { columnIds: index.columnIds.filter((x) => x !== cid) }))}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) edit((d) => updateIndex(d, table.id, index.id, { columnIds: [...index.columnIds, id] }));
                  }}
                >
                  <option value="">+ 컬럼 추가</option>
                  {table.columns.filter((c) => !index.columnIds.includes(c.id)).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            {(showMethod || showWhere) && (
              <details className="index-card__more" open={Boolean(index.method || index.where) || undefined}>
                <summary>방식·조건{index.method || index.where ? ` (${[index.method, index.where && 'WHERE'].filter(Boolean).join(', ')})` : ''}</summary>
                {showMethod && (
                  <label>
                    <span>방식</span>
                    <select value={index.method ?? ''} onChange={(e) => edit((d) => updateIndex(d, table.id, index.id, { method: e.target.value || undefined }))}>
                      <option value="">기본 (btree)</option>
                      {[...new Set([...methods, ...(index.method ? [index.method] : [])])].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                )}
                {showWhere && (
                  <label>
                    <span>조건</span>
                    <TextInput
                      className="mono"
                      value={index.where ?? ''}
                      placeholder="WHERE 뒤 조건 (부분 인덱스). 예) deleted_at IS NULL"
                      onCommit={(where) => edit((d) => updateIndex(d, table.id, index.id, { where: where.trim() || undefined }))}
                    />
                  </label>
                )}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RelationEditor({ relation }: { relation: Relation }) {
  const schema = useStore((s) => s.schema);
  const { edit, select } = useStore.getState();
  const child = findTable(schema, relation.fromTableId);
  const parent = findTable(schema, relation.toTableId);
  if (!child || !parent) return <EmptyInspector />;
  const set = (patch: Partial<Relation>) => edit((d) => updateRelation(d, relation.id, patch));
  const pairs = relation.fromColumnIds.map((id, i) => [child.columns.find((c) => c.id === id)?.name, parent.columns.find((c) => c.id === relation.toColumnIds[i])?.name]);

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <h3>관계 (외래키)</h3>
        <div className="btn-row">
          <button className="btn btn-sm" title="관계만 지우고 FK 컬럼은 남깁니다" onClick={() => { edit((d) => removeRelation(d, relation.id)); select(null); }}>관계만 삭제</button>
          <button className="btn btn-danger btn-sm" title="관계와 그 FK 컬럼을 함께 지웁니다 (Delete 키와 같음, 다른 관계가 쓰는 컬럼은 남김)" onClick={() => { edit((d) => removeRelation(d, relation.id, true)); select(null); }}>삭제 (FK 컬럼 포함)</button>
        </div>
      </div>
      <p className="relation-summary">
        <b>{parent.name}</b> (부모) → <b>{child.name}</b> (자식)
      </p>
      <ul className="relation-columns">
        {pairs.map(([c, p], i) => (
          <li key={i}><code>{child.name}.{c}</code> → <code>{parent.name}.{p}</code></li>
        ))}
      </ul>
      <div className="form-grid">
        <label>이름</label>
        <TextInput value={relation.name} placeholder={relationName(schema, { ...relation, name: '' })} onCommit={(name) => set({ name })} />
        <label>관계</label>
        <select value={relation.cardinality} onChange={(e) => set({ cardinality: e.target.value as Relation['cardinality'] })}>
          <option value="1:N">1 : N</option>
          <option value="1:1">1 : 1</option>
        </select>
        <label>ON DELETE</label>
        <select value={relation.onDelete} onChange={(e) => set({ onDelete: e.target.value as ReferentialAction })}>
          {ACTIONS.map((a) => <option key={a}>{a}</option>)}
        </select>
        <label>ON UPDATE</label>
        <select value={relation.onUpdate} onChange={(e) => set({ onUpdate: e.target.value as ReferentialAction })}>
          {ACTIONS.map((a) => <option key={a}>{a}</option>)}
        </select>
      </div>
    </aside>
  );
}
