import { useCallback, useState, type ReactNode } from 'react';
import { requestFocus, takeFocus } from '../lib/focus';
import {
  addColumn,
  addToArea,
  moveToArea,
  removeFromArea,
  addIndex,
  autoFixColumnPatch,
  canAutoIncrement,
  createCheck,
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
  tableTypeIssues,
  updateColumn,
  updateIndex,
  updateRelation,
  updateTable,
  type Column,
  type ReferentialAction,
  type Relation,
  type Table,
  type TableTypeIssue,
  type TypeIssueField,
} from '@erd/core';
import { selectAreas, useStore } from '../store';
import { Dropdown } from './ui';
import { ColorPicker } from './ColorPicker';
import { TemplateApplyMenu } from './TemplatePanels';
import { TableComments } from './Comments';
import { useDialect } from '../lib/hooks';

const ACTIONS: ReferentialAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer');
  let content: ReactNode = null;
  if (selection?.type === 'table') {
    const table = findTable(schema, selection.id);
    if (table) content = <TableEditor table={table} />;
  } else if (selection?.type === 'relation') {
    const relation = schema.relations.find((r) => r.id === selection.id);
    if (relation) content = <RelationEditor relation={relation} />;
  }
  if (!content) return null;
  // 보기 권한이면 모든 입력을 잠근다
  return readOnly ? <fieldset className="readonly-fieldset" disabled>{content}</fieldset> : content;
}

/** 입력 중에는 로컬 값만 바꾸고, 포커스를 잃거나 Enter를 누를 때 저장한다 (되돌리기 기록을 글자마다 남기지 않기 위해). */
function TextInput({ value, onCommit, placeholder, className, list, issue, focusKey, onEnter }: { value: string; onCommit: (v: string) => void; placeholder?: string; className?: string; list?: string; issue?: Mark; focusKey?: string; onEnter?: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  // 방금 만든 테이블·컬럼이면 이름 칸에 커서를 두고 전체 선택 (바로 타이핑해 이름을 바꾸게)
  const ref = useCallback((el: HTMLInputElement | null) => {
    if (el && takeFocus(focusKey)) requestAnimationFrame(() => { el.focus(); el.select(); });
  }, [focusKey]);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      ref={ref}
      className={[className, issue?.className].filter(Boolean).join(' ') || undefined}
      value={draft ?? value}
      // 칸이 좁아 잘려도 마우스를 올리면 전체 값이 보인다. 타입 문제가 있으면 그 이유도
      title={[issue?.title, draft ?? value].filter(Boolean).join('\n\n') || undefined}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
          onEnter?.();
        }
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** 타입 검사 결과를 편집 칸에 표시 (빨강: DB에서 실패, 주황: 주의) */
interface Mark {
  className: string;
  title: string;
}
function markOf(issues: TableTypeIssue[], columnId: string, field: TypeIssueField): Mark | undefined {
  const found = issues.filter((i) => i.columnId === columnId && i.field === field && i.severity !== 'info');
  if (!found.length) return undefined;
  const error = found.some((i) => i.severity === 'error');
  return { className: error ? 'type-error' : 'type-warning', title: found.map((i) => `${i.severity === 'error' ? '⛔ DB에서 실패' : '⚠ 주의'}: ${i.message}${i.fix ? ` (설계 검사에서 "${i.fix.label}")` : ''}`).join('\n') };
}

function TableEditor({ table }: { table: Table }) {
  const schema = useStore((s) => s.schema);
  const dialect = getDialect(useDialect());
  const { edit, select } = useStore.getState();
  const fkIds = foreignKeyColumnIds(schema, table.id);
  const setTable = (patch: Parameters<typeof updateTable>[2]) => edit((d) => updateTable(d, table.id, patch));
  // 지금 영역 탭이고 이 테이블이 그 영역에 있으면 (삭제 버튼 대신 영역에서 빼기)
  const currentArea = useStore((s) => (s.activeArea ? s.schema.areas?.find((a) => a.id === s.activeArea && a.tableIds.includes(table.id)) : undefined));
  const setColumn = (column: Column, patch: Partial<Column>) => edit((d) => updateColumn(d, table.id, column.id, patch));
  // 타입·길이·자동 증가·ON UPDATE를 바꿀 때 함께 바로잡는다 (예: VARCHAR(255)를 DATETIME으로 바꾸면 길이 255를 지움)
  const setColumnFixed = (column: Column, patch: Partial<Column>) => {
    const fixed = autoFixColumnPatch(dialect, column, patch);
    setColumn(column, fixed.patch);
    if (fixed.notes.length) useStore.getState().showNotice({ text: `함께 고쳤습니다: ${fixed.notes.join(' / ')} (Ctrl+Z로 되돌리기)` });
  };
  const setAutoIncrement = (column: Column, on: boolean) => {
    if (on && !canAutoIncrement(dialect, column)) {
      const type = `${column.type}${column.length ? `(${column.length})` : ''}`;
      if (!confirm(`${type}에는 자동 증가를 쓸 수 없습니다 (정수 타입만 가능).\n타입을 BIGINT로 바꾸고 자동 증가를 켤까요?`)) return;
      setColumn(column, { autoIncrement: true, type: 'BIGINT', length: '', defaultValue: null });
      return;
    }
    setColumnFixed(column, { autoIncrement: on });
  };
  const addColumnAndFocus = () =>
    edit((d) => {
      requestFocus(`column:${addColumn(d, table.id).id}`);
    });
  const typeIssues = tableTypeIssues(dialect, table);
  const mark = (column: Column, field: TypeIssueField) => markOf(typeIssues, column.id, field);

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <h3>테이블</h3>
        <div className="btn-row">
          <TemplateApplyMenu tableIds={[table.id]} />
          {/* 영역 탭에서는 그 영역에서만 빼고, 테이블 삭제는 전체 탭에서 (Delete 키와 같은 규칙) */}
          {currentArea ? (
            <button
              className="btn btn-sm"
              title="테이블은 전체에 남고 이 영역에서만 빠집니다. 테이블 삭제는 전체 탭에서 합니다"
              onClick={() => {
                edit((d) => removeFromArea(d, currentArea.id, [table.id]));
                select(null);
                useStore.getState().showNotice({ text: `${table.name}을(를) ${currentArea.name} 영역에서 뺐습니다. 테이블은 전체에 남아 있습니다 (Ctrl+Z로 되돌리기)` });
              }}
            >
              {currentArea.name} 영역에서 빼기
            </button>
          ) : (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => {
                const inAreas = (useStore.getState().schema.areas ?? []).some((a) => a.tableIds.includes(table.id));
                if (!confirm(`${table.name} 테이블을 삭제할까요?${inAreas ? ' 모든 영역에서도 사라집니다.' : ''}`)) return;
                edit((d) => removeTable(d, table.id));
                select(null);
              }}
            >
              삭제
            </button>
          )}
        </div>
      </div>
      <div className="form-grid">
        <label>물리명</label>
        <TextInput value={table.name} onCommit={(name) => setTable({ name })} focusKey={`table:${table.id}`} />
        <label>논리명</label>
        <TextInput value={table.logicalName} onCommit={(logicalName) => setTable({ logicalName })} placeholder="예: 회원" />
        <label>설명</label>
        <TextInput value={table.comment} onCommit={(comment) => setTable({ comment })} placeholder="비우면 논리명이 SQL 코멘트가 됩니다" />
        <label>영역</label>
        <TableAreas tableId={table.id} />
        <label>색상</label>
        <ColorPicker allowDefault value={table.color} onChange={(color) => setTable({ color })} />
      </div>

      <div className="inspector__section">
        <div className="inspector__section-head">
          <h4>컬럼 ({table.columns.length})</h4>
          <button className="btn btn-sm" onClick={addColumnAndFocus} title="컬럼 추가 (마지막 컬럼 이름에서 Enter로도 추가)">+ 컬럼</button>
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
              {/* 마지막 컬럼의 이름에서 Enter: 다음 컬럼을 바로 추가 */}
              <TextInput value={c.name} onCommit={(name) => setColumn(c, { name })} className={fkIds.has(c.id) ? 'is-fk' : ''} focusKey={`column:${c.id}`} onEnter={i === table.columns.length - 1 ? addColumnAndFocus : undefined} />
              <TextInput value={c.logicalName} onCommit={(logicalName) => setColumn(c, { logicalName })} onEnter={i === table.columns.length - 1 ? addColumnAndFocus : undefined} />
              <TextInput value={c.type} list="type-suggestions" issue={mark(c, 'type')} onCommit={(type) => setColumnFixed(c, { type: type.toUpperCase() })} />
              <TextInput value={c.length} issue={mark(c, 'length')} onCommit={(length) => setColumnFixed(c, { length })} />
              <input type="checkbox" checked={c.primaryKey} onChange={(e) => setColumn(c, { primaryKey: e.target.checked })} />
              <input type="checkbox" checked={!c.nullable || c.primaryKey} disabled={c.primaryKey} onChange={(e) => setColumn(c, { nullable: !e.target.checked })} />
              <input type="checkbox" checked={c.unique} disabled={c.primaryKey} onChange={(e) => setColumn(c, { unique: e.target.checked })} />
              <input
                type="checkbox"
                checked={c.autoIncrement}
                className={mark(c, 'autoIncrement')?.className}
                title={mark(c, 'autoIncrement')?.title ?? '자동 증가'}
                onChange={(e) => setAutoIncrement(c, e.target.checked)}
              />
              <span className="default-cell">
                {c.generated ? (
                  <TextInput
                    className="mono generated-input"
                    value={c.generated.expression}
                    placeholder="계산식 예: qty * price"
                    onCommit={(expression) => setColumn(c, { generated: { ...c.generated!, expression } })}
                  />
                ) : (
                  <TextInput value={c.defaultValue ?? ''} placeholder="NULL" issue={mark(c, 'defaultValue')} onCommit={(v) => setColumn(c, { defaultValue: v.trim() === '' ? null : v })} />
                )}
                <button
                  className={`generated-btn${c.generated ? ' on' : ''}`}
                  title={
                    c.generated
                      ? `계산 컬럼 (${c.generated.stored ? 'STORED: 값을 저장' : 'VIRTUAL: 읽을 때 계산'}) — 누르면 ${c.generated.stored ? '일반 컬럼으로' : 'STORED로'}`
                      : '계산 컬럼으로 (GENERATED ALWAYS AS): 다른 컬럼으로 값을 계산합니다'
                  }
                  onClick={() =>
                    setColumn(c, {
                      generated: !c.generated ? { expression: '', stored: dialect.id === 'postgresql' } : !c.generated.stored && dialect.id !== 'postgresql' && dialect.id !== 'oracle' ? { ...c.generated, stored: true } : undefined,
                      ...(c.generated ? {} : { defaultValue: null, autoIncrement: false }),
                    })
                  }
                >
                  ƒ{c.generated?.stored ? <sub>S</sub> : null}
                </button>
                {/* MySQL·MariaDB 날짜 컬럼: 행이 바뀔 때 현재 시각으로 (ON UPDATE CURRENT_TIMESTAMP) */}
                {(dialect.id === 'mysql' || dialect.id === 'mariadb') && /^(TIMESTAMP|DATETIME)/i.test(c.type) && (
                  <button
                    className={`onupdate-btn${c.onUpdate ? ' on' : ''}${mark(c, 'onUpdate') ? ` ${mark(c, 'onUpdate')!.className}` : ''}`}
                    title={[mark(c, 'onUpdate')?.title, c.onUpdate ? `ON UPDATE ${c.onUpdate} (행이 바뀔 때마다 현재 시각) — 누르면 끕니다` : '행이 바뀔 때마다 현재 시각으로 (ON UPDATE CURRENT_TIMESTAMP)'].filter(Boolean).join('\n\n')}
                    // 자릿수는 컬럼의 소수 초 자릿수(0~6)와 같아야 한다
                    onClick={() => setColumn(c, { onUpdate: c.onUpdate ? undefined : /^[1-6]$/.test(c.length.trim()) ? `CURRENT_TIMESTAMP(${c.length.trim()})` : 'CURRENT_TIMESTAMP' })}
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
      <CheckEditor table={table} />
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

/** CHECK 제약: 이름(비우면 ck_테이블_번호)과 조건식 */
function CheckEditor({ table }: { table: Table }) {
  const { edit } = useStore.getState();
  const checks = table.checks ?? [];
  const update = (fn: (list: NonNullable<Table['checks']>) => NonNullable<Table['checks']>) =>
    edit((d) => {
      const t = findTable(d, table.id);
      if (!t) return;
      const next = fn(t.checks ?? []);
      if (next.length) t.checks = next;
      else delete t.checks;
    });
  return (
    <div className="inspector__section">
      <div className="inspector__section-head">
        <h4>CHECK 제약 ({checks.length})</h4>
        <button className="btn btn-sm" title="값이 지켜야 할 조건. 예: point >= 0" onClick={() => update((list) => {
          // 새 CHECK의 조건 칸으로 커서를 옮긴다 (버튼에 머물면 스페이스가 버튼을 다시 눌러 빈 CHECK가 생김)
          const check = createCheck({ expression: '' });
          requestFocus(`check:${check.id}`);
          return [...list, check];
        })}>
          + CHECK
        </button>
      </div>
      {checks.length === 0 && <p className="muted">값이 지켜야 할 조건을 걸 수 있습니다. 예) point &gt;= 0, status IN ('READY','DONE')</p>}
      {checks.map((check, i) => (
        <div key={check.id} className="check-row">
          <TextInput
            value={check.name}
            placeholder={`ck_${table.name}_${i + 1}`}
            onCommit={(name) => update((list) => list.map((k) => (k.id === check.id ? { ...k, name: name.trim() } : k)))}
          />
          <TextInput
            className="mono"
            value={check.expression}
            placeholder="조건 예: point >= 0"
            focusKey={`check:${check.id}`}
            onCommit={(expression) => update((list) => list.map((k) => (k.id === check.id ? { ...k, expression: expression.trim().replace(/^check\s*/i, '') } : k)))}
          />
          <button className="icon-btn danger" title="CHECK 삭제" onClick={() => update((list) => list.filter((k) => k.id !== check.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

/** 새 인덱스의 첫 컬럼: 기본키가 아니고 아직 어느 인덱스의 첫 컬럼도 아닌 컬럼 (기본키에 또 걸면 바로 중복 인덱스가 됨) */
function firstUnindexedColumn(table: Table) {
  const leading = new Set(table.indexes.map((i) => i.columnIds[0]));
  return table.columns.find((c) => !c.primaryKey && !leading.has(c.id)) ?? table.columns.find((c) => !c.primaryKey) ?? table.columns[0];
}

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
          <button className="btn btn-sm" disabled={table.columns.length === 0} onClick={() => edit((d) => addIndex(d, table.id, { columnIds: [firstUnindexedColumn(table).id] }))}>
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
  if (!child || !parent) return null;
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

/**
 * 테이블이 들어 있는 주제영역: 칩(× 누르면 그 영역에서 빼기) + 영역에 넣기 + (영역 탭이면) 다른 영역으로 옮기기.
 * 테이블을 지우는 게 아니라 영역 구분만 바꾼다.
 */
function TableAreas({ tableId }: { tableId: string }) {
  const areas = useStore(selectAreas);
  const activeArea = useStore((s) => s.activeArea);
  const { edit } = useStore.getState();
  const mine = areas.filter((a) => a.tableIds.includes(tableId));
  const others = areas.filter((a) => !a.tableIds.includes(tableId));
  const current = mine.find((a) => a.id === activeArea);
  if (!areas.length) return <span className="muted small">영역이 없습니다. 캔버스 위 "+ 영역"으로 만들 수 있습니다.</span>;
  return (
    <div className="table-areas">
      {mine.map((a) => (
        <span key={a.id} className="area-chip" style={{ ['--area-color' as string]: a.color || 'var(--accent)' }}>
          <span className="area-tab__dot" />
          {a.name}
          <button
            className="icon-btn"
            title={`${a.name} 영역에서 빼기 (테이블은 남음)`}
            onClick={() => edit((d) => removeFromArea(d, a.id, [tableId]))}
          >
            ×
          </button>
        </span>
      ))}
      {mine.length === 0 && <span className="muted small">어느 영역에도 없음</span>}
      {others.length > 0 && (
        <Dropdown
          label="영역에 넣기"
          title="이 테이블을 다른 영역에도 보이게 (지금 영역에도 그대로 남음)"
          items={others.map((a) => ({ label: a.name, onClick: () => edit((d) => void addToArea(d, a.id, [tableId])) }))}
        />
      )}
      {current && others.length > 0 && (
        <Dropdown
          label="옮기기"
          title={`${current.name} 영역에서 빼고 다른 영역으로`}
          items={others.map((a) => ({ label: `${current.name} → ${a.name}`, onClick: () => edit((d) => moveToArea(d, a.id, [tableId], current.id)) }))}
        />
      )}
    </div>
  );
}
