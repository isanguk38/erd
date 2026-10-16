import { useEffect, useRef, type ReactNode } from 'react';
import { requestFocus } from '../lib/focus';
import { Slot, useFeatures, useSlot } from '../features/registry';
import { TextInput, type Mark } from './TextInput';
import { PrivacyMenu } from './PrivacyMenu';
import {
  addColumn,
  addToArea,
  moveToArea,
  removeFromArea,
  addIndex,
  autoFixColumnPatch,
  canAutoIncrement,
  columnDeleteImpact,
  NAME_STYLE_LABEL,
  checkColumnAgainstDictionary,
  checkTableAgainstDictionary,
  describeMatch,
  dictIndex,
  dictionaryPatch,
  lookupPhysical,
  lookupTablePhysical,
  lookupTerm,
  setDictEntry,
  suggestTerms,
  termFromTable,
  type DictTerm,
  fitsStyle,
  projectNamingStyles,
  namingRuleText,
  type NameKind,
  toStyle,
  propagateColumnType,
  tableDeleteImpact,
  typeMismatches,
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
  canonicalType,
  enumOfType,
  typeName,
  updateColumn,
  updateIndex,
  updateRelation,
  updateTable,
  type Column,
  type Index,
  type ReferentialAction,
  type Relation,
  type Table,
  type TableTypeIssue,
  type TypeIssueField,
} from '@erd/core';
import { selectAreas, useStore } from '../store';
import { Dropdown } from './ui';
import { ColorPicker, usedColors } from './ColorPicker';
import { TemplateApplyMenu } from './TemplatePanels';
import { TableComments } from './Comments';
import { useDialect } from '../lib/hooks';
import { confirmImpact } from '../lib/impact';

/** 아직 이름을 정하지 않은 새 컬럼·테이블 (표준 용어 사전으로 이름을 채워도 되는 것) */
const DEFAULT_COLUMN_NAME = /^column(_\d+)?$/;
const DEFAULT_TABLE_NAME = /^new_table(_\d+)?$/;
const fullType = (c: { type: string; length: string }) => `${c.type}${c.length ? `(${c.length})` : ''}`;

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



function markOf(issues: TableTypeIssue[], columnId: string, field: TypeIssueField): Mark | undefined {
  const found = issues.filter((i) => i.columnId === columnId && i.field === field && i.severity !== 'info');
  if (!found.length) return undefined;
  const error = found.some((i) => i.severity === 'error');
  return { className: error ? 'type-error' : 'type-warning', title: found.map((i) => `${i.severity === 'error' ? '⛔ DB에서 실패' : '⚠ 주의'}: ${i.message}${i.fix ? ` (설계 검사에서 "${i.fix.label}")` : ''}`).join('\n') };
}

function TableEditor({ table }: { table: Table }) {
  const schema = useStore((s) => s.schema);
  // 검색에서 고른 컬럼: 캔버스처럼 편집 창에서도 그 줄을 표시하고 보이는 곳으로 스크롤한다
  // (이 테이블을 보는 동안 표시는 남는다 — 다른 것을 고르면 지워지고, 다시 검색하면 바뀜)
  const focusColumnId = useStore((s) => (s.searchFocus?.tableId === table.id ? s.searchFocus.columnId : undefined));
  const focusAt = useStore((s) => s.searchFocus?.at);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusColumnId) return;
    // 편집 창이 열리는 동안 기다렸다가 스크롤한다
    const t = setTimeout(() => {
      const row = gridRef.current?.querySelector<HTMLElement>(`[data-column-id="${CSS.escape(focusColumnId)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      // 가로로 밀려 있으면 물리명 칸이 보이게 맨 왼쪽으로
      const scroller = row.closest<HTMLElement>('.column-grid');
      if (scroller) scroller.scrollLeft = 0;
    }, 120);
    return () => clearTimeout(t);
  }, [focusColumnId, focusAt]);
  const dialect = getDialect(useDialect());
  const { edit, select } = useStore.getState();
  const fkIds = foreignKeyColumnIds(schema, table.id);
  const setTable = (patch: Parameters<typeof updateTable>[2]) => edit((d) => updateTable(d, table.id, patch));
  // 지금 영역 탭이고 이 테이블이 그 영역에 있으면 (삭제 버튼 대신 영역에서 빼기)
  const enums = useStore((s) => s.schema.enums);
  const currentArea = useStore((s) => (s.activeArea ? s.schema.areas?.find((a) => a.id === s.activeArea && a.tableIds.includes(table.id)) : undefined));
  const setColumn = (column: Column, patch: Partial<Column>) => edit((d) => updateColumn(d, table.id, column.id, patch));
  // 타입·길이·자동 증가·ON UPDATE를 바꿀 때 함께 바로잡는다 (예: VARCHAR(255)를 DATETIME으로 바꾸면 길이 255를 지움)
  const setColumnFixed = (column: Column, patch: Partial<Column>) => {
    const fixed = autoFixColumnPatch(dialect, column, patch);
    setColumn(column, fixed.patch);
    const fixedText = fixed.notes.length ? `함께 고쳤습니다: ${fixed.notes.join(' / ')}. ` : '';
    // 영향도: 타입·길이를 바꿨는데 FK로 이어진 컬럼은 그대로면 같이 바꿀지 묻는다
    const off = typeMismatches(useStore.getState().schema, table.id, column.id);
    if (off.length && (fixed.patch.type !== undefined || fixed.patch.length !== undefined)) {
      const after = useStore.getState().schema.tables.find((t) => t.id === table.id)?.columns.find((c) => c.id === column.id);
      useStore.getState().showNotice({
        text: `${fixedText}${table.name}.${column.name}와 FK로 이어진 ${off.slice(0, 3).map((l) => `${l.table}.${l.column}(${fullType(l)})`).join(', ')}${off.length > 3 ? ` 외 ${off.length - 3}개` : ''}는 타입이 다릅니다`,
        action: { label: `${off.length}개도 ${after ? fullType(after) : '같은 타입'}으로`, run: () => edit((d) => void propagateColumnType(d, table.id, column.id)) },
      });
      return;
    }
    if (fixedText) useStore.getState().showNotice({ text: `${fixedText}(Ctrl+Z로 되돌리기)` });
  };
  // 표준 용어 사전: 논리명을 넣으면 표준 물리명·타입을 채우고(아직 이름을 안 정한 컬럼), 이미 이름이 있으면 바꿀지 묻는다
  const dictionary = useStore((s) => s.dictionary);
  const dict = dictionary ? dictIndex(dictionary) : null;
  // 이름 표기 기준(snake_case 등, 정하지 않았으면 사전 표기): 기준과 다른 이름을 입력하면 바꿀지 안내하고 칸에 표시한다
  // 테이블·컬럼 기준이 다를 수 있다 (값 하나씩 읽는다 — 객체를 돌려주면 매번 새 값이라 다시 그리기를 반복한다)
  const tableStyle = useStore((s) => projectNamingStyles(s.meta.namingStyle, s.schema, s.dictionary ? dictIndex(s.dictionary).styles : null).table.style);
  const columnStyle = useStore((s) => projectNamingStyles(s.meta.namingStyle, s.schema, s.dictionary ? dictIndex(s.dictionary).styles : null).column.style);
  const naming = { table: tableStyle, column: columnStyle };
  const offStyle = (name: string, kind: NameKind) => {
    const st = naming[kind];
    return st && name.trim() && !fitsStyle(name, st) ? toStyle(name, st) : null;
  };
  /** 기준과 다르면 안내하고 true */
  const adviseName = (name: string, rename: (to: string) => void, kind: NameKind) => {
    const to = offStyle(name, kind);
    const st = naming[kind];
    if (!to || !st || !fitsStyle(to, st)) return false;
    useStore.getState().showNotice({ text: `이 프로젝트는 ${namingRuleText(naming, kind)} 기준입니다 — ${kind === 'table' ? '테이블' : '컬럼'} ${name} 대신 ${to}`, action: { label: `${to}(으)로 바꾸기`, run: () => rename(to) } });
    return true;
  };
  const nameMark = (name: string, kind: NameKind): Mark | undefined => {
    if (DEFAULT_COLUMN_NAME.test(name) || DEFAULT_TABLE_NAME.test(name)) return undefined;
    const to = offStyle(name, kind);
    return to ? { className: 'naming-off', title: `이 프로젝트는 ${namingRuleText(naming, kind)} 기준입니다${to !== name ? ` — ${to}(으)로 바꾸세요` : ''}` } : undefined;
  };
  // 사전에 없는 용어면 안내 (사전에 추가 / 논리명 맞추기). 표기가 기준과 다르면 표기 안내가 먼저다
  const adviseDictionary = (column: Column) => {
    if (!dict) return;
    const now = useStore.getState().schema.tables.find((t) => t.id === table.id)?.columns.find((c) => c.id === column.id);
    if (!now || DEFAULT_COLUMN_NAME.test(now.name) || offStyle(now.name, 'column')) return; // 물리명을 아직 안 정했으면 다음 입력을 기다린다
    const r = checkColumnAgainstDictionary(dict, now);
    if (r?.status !== 'unknown') return;
    const owner = lookupPhysical(dict, now.name);
    if (owner) {
      useStore.getState().showNotice({ text: `"${now.logicalName}"은(는) 용어 사전에 없습니다. 물리명 ${now.name}은(는) 사전에 "${owner.logical}"(으)로 있습니다`, action: { label: `논리명을 "${owner.logical}"(으)로`, run: () => edit((d) => void updateColumn(d, table.id, now.id, { logicalName: owner.logical })) } });
      return;
    }
    useStore.getState().showNotice({
      text: `"${now.logicalName}"(${now.name})은(는) 용어 사전에 없습니다 — 용어 사전에 추가해 주세요`,
      action: {
        label: '사전에 추가',
        run: () => {
          const term: DictTerm = { logical: now.logicalName.trim(), physical: now.name, ...(now.type ? { type: now.type } : {}), ...(now.length ? { length: now.length } : {}), ...(now.comment.trim() ? { description: now.comment.trim() } : {}) };
          if (useStore.getState().editDictionary((d) => setDictEntry(d, term))) useStore.getState().showNotice({ text: `용어 사전에 추가했습니다: ${term.logical} = ${term.physical}` });
        },
      },
    });
  };
  // 자동완성에서 고른 표준 용어: 물리명·논리명·타입·길이를 한 번에
  const pickTerm = (column: Column, term: DictTerm) => {
    const st = dictionaryPatch({ physical: term.physical, type: term.type, length: term.length });
    setColumn(column, { ...st, logicalName: term.logical });
    useStore.getState().showNotice({ text: `표준 용어: ${term.logical} → ${describeMatch({ physical: term.physical, type: term.type, length: term.length })} (Ctrl+Z로 되돌리기)` });
  };
  const suggestByPhysical = dictionary ? (q: string) => suggestTerms(dictionary, q, 'physical') : undefined;
  const suggestByLogical = dictionary ? (q: string) => suggestTerms(dictionary, q, 'logical') : undefined;
  const setLogicalName = (column: Column, logicalName: string) => {
    const match = dict ? lookupTerm(dict, logicalName) : null;
    if (!match) {
      setColumn(column, { logicalName });
      adviseDictionary(column);
      return;
    }
    const patch = dictionaryPatch(match);
    if (DEFAULT_COLUMN_NAME.test(column.name) || !column.name.trim()) {
      setColumn(column, { logicalName, ...patch });
      useStore.getState().showNotice({ text: `표준 용어 사전: ${logicalName} → ${describeMatch(match)} (Ctrl+Z로 되돌리기)` });
      return;
    }
    setColumn(column, { logicalName });
    const check = checkColumnAgainstDictionary(dict, { ...column, logicalName });
    if (check?.status === 'mismatch') {
      useStore.getState().showNotice({
        text: `표준 용어 사전의 ${logicalName}은(는) ${describeMatch(match)}입니다 (지금: ${column.name} ${fullType(column)})`,
        action: { label: '표준대로 바꾸기', run: () => edit((d) => void updateColumn(d, table.id, column.id, check.patch!)) },
      });
    }
  };
  // 물리명만 넣고 논리명이 비어 있으면 사전에서 논리명을 채운다
  const setPhysicalName = (column: Column, name: string) => {
    const found = dict && !column.logicalName.trim() ? lookupPhysical(dict, name) : null;
    const term = found?.logical ? found : null;
    setColumn(column, term ? { name, logicalName: term.logical } : { name });
    if (term) useStore.getState().showNotice({ text: `표준 용어 사전: ${name} → 논리명 ${term.logical} (Ctrl+Z로 되돌리기)` });
    else if (!adviseName(name, (to) => edit((d) => void updateColumn(d, table.id, column.id, { name: to })), 'column')) adviseDictionary(column);
  };
  const dictMark = (column: Column): Mark | undefined => {
    const r = checkColumnAgainstDictionary(dict, column);
    if (!r || r.status === 'ok') return undefined;
    return r.status === 'unknown'
      ? { className: 'dict-unknown', title: '표준 용어 사전에 없는 논리명입니다 — 용어 사전에 추가해 주세요' }
      : { className: 'dict-mismatch', title: `표준: ${describeMatch(r.match!)} (다른 점: ${r.diffs.join(', ')}) — 설계 검사에서 "표준대로"로 맞출 수 있습니다` };
  };
  // 테이블은 자동으로 채우지 않는다 — 같은 이름 테이블을 막고(ERD가 막음), 사전과 다르면·없으면 알린다
  const adviseTable = () => {
    if (!dict) return;
    const now = useStore.getState().schema.tables.find((t) => t.id === table.id);
    if (!now || DEFAULT_TABLE_NAME.test(now.name) || offStyle(now.name, 'table')) return;
    const r = checkTableAgainstDictionary(dict, now);
    const notice = useStore.getState().showNotice;
    if (r?.status === 'mismatch') {
      notice({ text: `용어 사전의 테이블 "${now.logicalName}"은(는) ${r.physical}입니다 (지금: ${now.name})`, action: { label: `${r.physical}(으)로 바꾸기`, run: () => edit((d) => void updateTable(d, table.id, { name: r.physical })) } });
      return;
    }
    if (r?.status !== 'unknown') return;
    const owner = lookupTablePhysical(dict, now.name);
    if (owner) {
      notice({ text: `테이블 "${now.logicalName}"은(는) 용어 사전에 없습니다. ${now.name}은(는) 사전에 "${owner.logical}"(으)로 있습니다`, action: { label: `논리명을 "${owner.logical}"(으)로`, run: () => edit((d) => void updateTable(d, table.id, { logicalName: owner.logical })) } });
      return;
    }
    notice({
      text: `테이블 "${now.logicalName}"(${now.name})은(는) 용어 사전에 없습니다 — 용어 사전에 추가해 주세요`,
      action: {
        label: '사전에 추가',
        run: () => {
          const term = termFromTable(now);
          if (useStore.getState().editDictionary((d) => setDictEntry(d, term))) notice({ text: `용어 사전에 테이블을 추가했습니다: ${term.logical} = ${term.physical}` });
        },
      },
    });
  };
  const setTableName = (patch: { name?: string; logicalName?: string }) => {
    setTable(patch);
    if (patch.name !== undefined && adviseName(patch.name, (to) => edit((d) => void updateTable(d, table.id, { name: to })), 'table')) return;
    adviseTable();
  };
  const tableMark = (field: 'name' | 'logical'): Mark | undefined => {
    if (field === 'name' && nameMark(table.name, 'table')) return nameMark(table.name, 'table');
    if (!dict) return undefined;
    const r = checkTableAgainstDictionary(dict, table);
    if (field === 'logical') return r?.status === 'unknown' ? { className: 'dict-unknown', title: '용어 사전에 없는 테이블입니다 — 용어 사전에 추가해 주세요' } : undefined;
    return r?.status === 'mismatch' ? { className: 'dict-mismatch', title: `사전의 표준 테이블 물리명은 ${r.physical}입니다` } : undefined;
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
  const typeIssues = tableTypeIssues(dialect, table, enums);
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
                // 영향도: 이 테이블을 참조하는 다른 테이블의 외래키, 영역
                const impact = tableDeleteImpact(useStore.getState().schema, table.id);
                if (!(impact.length ? confirmImpact(`${table.name} 테이블을 삭제하면 함께 바뀝니다:`, impact) : confirm(`${table.name} 테이블을 삭제할까요?`))) return;
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
        <TextInput value={table.name} onCommit={(name) => setTableName({ name })} issue={tableMark('name')} focusKey={`table:${table.id}`} />
        <label>논리명</label>
        <TextInput value={table.logicalName} onCommit={(logicalName) => setTableName({ logicalName })} issue={tableMark('logical')} placeholder="예: 회원 (DB comment로 들어갑니다)" />
        <label>설명</label>
        <TextInput value={table.comment} onCommit={(comment) => setTable({ comment })} placeholder="상세 설명 — ERD에만 저장 (DB에는 들어가지 않음)" />
        <label>영역</label>
        <TableAreas tableId={table.id} />
        <label>색상</label>
        <ColorPicker allowDefault value={table.color} recent={usedColors(schema.tables.map((t) => t.color))} onChange={(color) => setTable({ color })} />
      </div>

      <div className="inspector__section">
        <div className="inspector__section-head">
          <h4>컬럼 ({table.columns.length})</h4>
          <button className="btn btn-sm" onClick={addColumnAndFocus} title="컬럼 추가 (마지막 컬럼 이름에서 Enter로도 추가)">+ 컬럼</button>
        </div>
        <datalist id="type-suggestions">
          {/* 사용자 정의 타입(ENUM)을 먼저 */}
          {(enums ?? []).map((e) => <option key={e.id} value={e.name} label={`ENUM ${e.values.join(', ')}`} />)}
          {dialect.typeSuggestions.map((t) => <option key={t} value={t} />)}
        </datalist>
        <div className="column-grid" ref={gridRef}>
          <div className="column-grid__head">
            <span>물리명</span><span>논리명</span><span>타입</span><span>길이</span>
            <span title="기본키">PK</span><span title="NOT NULL">NN</span><span title="UNIQUE">UQ</span><span title="자동 증가">AI</span>
            <span>기본값</span><span title="ERD에만 저장되는 상세 설명. DB comment에는 논리명이 들어갑니다">설명</span><span />
          </div>
          {table.columns.map((c, i) => (
            <div key={c.id} data-column-id={c.id} className={`column-grid__row${focusColumnId === c.id ? ' search-focus' : ''}`} title={focusColumnId === c.id ? '검색에서 고른 컬럼' : undefined}>
              {/* 마지막 컬럼의 이름에서 Enter: 다음 컬럼을 바로 추가 */}
              <TextInput value={c.name} onCommit={(name) => setPhysicalName(c, name)} className={fkIds.has(c.id) ? 'is-fk' : ''} issue={nameMark(c.name, 'column')} focusKey={`column:${c.id}`} onEnter={i === table.columns.length - 1 ? addColumnAndFocus : undefined} suggest={suggestByPhysical} onPick={(t) => pickTerm(c, t)} />
              <TextInput value={c.logicalName} issue={dictMark(c)} onCommit={(logicalName) => setLogicalName(c, logicalName)} onEnter={i === table.columns.length - 1 ? addColumnAndFocus : undefined} suggest={suggestByLogical} onPick={(t) => pickTerm(c, t)} />
              <div className="type-cell">
                <TextInput value={c.type} list="type-suggestions" issue={mark(c, 'type')} onCommit={(type) => setColumnFixed(c, enumOfType(enums, type) ? { type: canonicalType({ enums }, type), length: '' } : { type: typeName(type) })} />
                <Slot name="typeCell" table={table} column={c} enums={enums} unknownType={typeIssues.some((x) => x.columnId === c.id && x.code === 'unknown-type')} />
              </div>
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
                {/* 기능 모듈 버튼 (계산 컬럼 ƒ, ON UPDATE ↻ 등 — 프로젝트 DB에 있는 기능만) */}
                <Slot name="columnTools" table={table} column={c} mark={mark(c, 'onUpdate')} setColumn={(patch) => setColumn(c, patch)} />
              </span>
              <TextInput value={c.comment} onCommit={(comment) => setColumn(c, { comment })} />
              <span className="row-actions">
                <PrivacyMenu column={c} onChange={(privacy) => setColumn(c, { privacy })} />
                <button className="icon-btn" title="위로" disabled={i === 0} onClick={() => edit((d) => moveColumn(d, table.id, c.id, i - 1))}>↑</button>
                <button className="icon-btn" title="아래로" disabled={i === table.columns.length - 1} onClick={() => edit((d) => moveColumn(d, table.id, c.id, i + 1))}>↓</button>
                <button
                  className="icon-btn danger"
                  title="삭제"
                  onClick={() => {
                    // 영향도: 이 컬럼을 쓰는 외래키·인덱스·CHECK·계산식이 있으면 확인
                    const impact = columnDeleteImpact(useStore.getState().schema, table.id, c.id);
                    if (!confirmImpact(`${table.name}.${c.name} 컬럼을 지우면 함께 바뀝니다:`, impact)) return;
                    edit((d) => removeColumn(d, table.id, c.id));
                  }}
                >
                  ×
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <IndexEditor table={table} />
      {/* 기능 모듈 구역 (CHECK 등 — 프로젝트 DB에 있는 기능만) */}
      <Slot name="tableSections" table={table} />
      <TableComments table={table} />
    </aside>
  );
}

/** 식 인덱스 예시 (DB 종류별 문법) */


/** 새 인덱스의 첫 컬럼: 기본키가 아니고 아직 어느 인덱스의 첫 컬럼도 아닌 컬럼 (기본키에 또 걸면 바로 중복 인덱스가 됨) */
function firstUnindexedColumn(table: Table) {
  const leading = new Set(table.indexes.map((i) => i.columnIds[0]));
  return table.columns.find((c) => !c.primaryKey && !leading.has(c.id)) ?? table.columns.find((c) => !c.primaryKey) ?? table.columns[0];
}

/** 인덱스 카드의 "방식·조건" 접기 제목 */
const optionLabel = (index: Index) => `방식·조건${index.method || index.where ? ` (${[index.method, index.where && 'WHERE'].filter(Boolean).join(', ')})` : ''}`;

function IndexEditor({ table }: { table: Table }) {
  const { edit } = useStore.getState();
  // 식 인덱스 안내는 그 DB의 식 인덱스 모듈이 준다 (없으면 그 DB에는 식 인덱스가 없다)
  const expressionFeature = useFeatures().expressionIndex;
  const optionParts = useSlot('indexOptions');
  return (
    <div className="inspector__section">
      <div className="inspector__section-head">
        <h4>인덱스 ({table.indexes.length})</h4>
        <span className="row-gap">
          <button className="btn btn-sm" disabled={table.columns.length === 0} onClick={() => edit((d) => addIndex(d, table.id, { columnIds: [firstUnindexedColumn(table).id] }))}>
            + 인덱스
          </button>
          <Slot name="indexHead" table={table} />
        </span>
      </div>
      {table.indexes.length === 0 && <p className="muted">조회 조건에 자주 쓰는 컬럼에 인덱스를 추가하세요. 컬럼의 UQ 체크는 UNIQUE 인덱스로 만들어집니다.</p>}
      {table.indexes.map((index) => {
        const isExpression = index.expression !== undefined;
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
                    placeholder={expressionFeature?.example(table.columns[0]?.name ?? 'name')}
                    onCommit={(expression) => edit((d) => updateIndex(d, table.id, index.id, { expression }))}
                  />
                </label>
                {expressionFeature && <p className="muted small">{expressionFeature.hint}</p>}
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
            {/* 방식·조건: 인덱스 방식·부분 인덱스 모듈이 있는 DB만 */}
            {optionParts.length > 0 && (
              <details className="index-card__more" open={Boolean(index.method || index.where) || undefined}>
                <summary>{optionLabel(index)}</summary>
                <Slot name="indexOptions" table={table} index={index} />
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
        <TextInput
          value={relation.name}
          placeholder={relationName(schema, { ...relation, name: '' })}
          onCommit={(name) => {
            // 다른 외래키가 쓰는 이름이면 바꾸지 않고 알린다 (DB에서 두 번째 외래키가 실패하므로)
            try {
              updateRelation(structuredClone(schema), relation.id, { name });
            } catch (e) {
              useStore.getState().showNotice({ text: e instanceof Error ? e.message : String(e) });
              return;
            }
            set({ name });
          }}
        />
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
