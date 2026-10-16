import { useEffect, useRef, useState } from 'react';
import { dictIndex, isNameStyle, NAME_KIND_LABEL, NAME_KINDS, NAME_STYLE_EXAMPLE, NAME_STYLE_LABEL, NAME_STYLES, namingIssues, projectNamingStyles, stylesOf, type NameKind } from '@erd/core';
import { useStore } from '../store';

const FROM_LABEL = { saved: '', dictionary: '사전', names: '자동' } as const;

/**
 * 헤더의 이름 표기 기준 배지: 테이블·컬럼 기준을 따로 보여 주고 고른다.
 * 같으면 "snake_case", 다르면 "테이블 camelCase · 컬럼 snake_case". 고르지 않은 쪽은 사전 표기나 많이 쓰는 표기로 판단한다.
 */
export function NamingBadge({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // 객체를 돌려주면 매번 새 값이라 다시 그리기를 반복하므로 값 하나씩 읽는다
  const resolved = (s: ReturnType<typeof useStore.getState>) => projectNamingStyles(s.meta.namingStyle, s.schema, s.dictionary ? dictIndex(s.dictionary).styles : null);
  const tableStyle = useStore((s) => resolved(s).table.style);
  const tableFrom = useStore((s) => resolved(s).table.from);
  const columnStyle = useStore((s) => resolved(s).column.style);
  const columnFrom = useStore((s) => resolved(s).column.from);
  const savedTable = useStore((s) => s.meta.namingStyle?.table ?? null);
  const savedColumn = useStore((s) => s.meta.namingStyle?.column ?? null);
  // 기준과 다른 이름 수 (테이블·컬럼) — 문자열 하나로 읽어 다시 그리기를 줄인다
  const offCounts = useStore((s) => {
    if (!open) return '';
    const issues = namingIssues(s.schema, stylesOf(resolved(s)));
    return `${issues.filter((i) => !i.columnId).length},${issues.filter((i) => i.columnId).length}`;
  });
  const [offTables, offColumns] = offCounts ? offCounts.split(',').map(Number) : [0, 0];
  const info = { table: { style: tableStyle, from: tableFrom, saved: savedTable }, column: { style: columnStyle, from: columnFrom, saved: savedColumn } };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const text = (kind: NameKind) => {
    const { style, from } = info[kind];
    if (!style) return '자동';
    return `${NAME_STYLE_LABEL[style]}${FROM_LABEL[from] ? ` (${FROM_LABEL[from]})` : ''}`;
  };
  const same = tableStyle === columnStyle && tableFrom === columnFrom;
  // 헤더가 넘치지 않게 짧게: 같으면 "snake_case (사전)", 다르면 "테이블 snake_case · 컬럼 camelCase" (어디서 정했는지는 마우스를 올리면)
  const short = (kind: NameKind) => (info[kind].style ? NAME_STYLE_LABEL[info[kind].style!] : '자동');
  // 표기가 같으면 하나로 (정한 곳이 다르면 사전을 따른 쪽을 보여 줌)
  const sameStyleFrom = tableFrom === 'dictionary' || columnFrom === 'dictionary' ? 'dictionary' : tableFrom;
  const label = !tableStyle && !columnStyle
    ? '표기 기준: 자동'
    : same
      ? text('table')
      : tableStyle === columnStyle
        ? `${NAME_STYLE_LABEL[tableStyle!]}${FROM_LABEL[sameStyleFrom] ? ` (${FROM_LABEL[sameStyleFrom]})` : ''}`
        : `테이블 ${short('table')} · 컬럼 ${short('column')}`;
  const detail = `테이블 ${text('table')} · 컬럼 ${text('column')}`;
  const auto = !savedTable && !savedColumn;

  const choose = (kind: NameKind, value: string) => {
    const next = { table: savedTable, column: savedColumn, [kind]: isNameStyle(value) ? value : null };
    useStore.getState().setNamingStyle(next.table || next.column ? next : null);
  };
  const both = (value: string) => {
    const style = isNameStyle(value) ? value : null;
    useStore.getState().setNamingStyle(style ? { table: style, column: style } : null);
  };

  return (
    <div className="dropdown naming-badge" ref={ref}>
      <button
        className={`chip-select naming-chip${auto ? ' auto' : ''}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`이름 표기 기준: ${detail}\n테이블·컬럼 물리명을 이 표기로 맞춥니다 (따로 정할 수 있음). 설계 검사가 다른 이름을 알려 주고, AI도 이 기준으로 만듭니다.`}
      >
        <span className="naming-chip__text">{label}</span> ▾
      </button>
      {open && (
        <div className="dropdown__menu naming-panel" role="dialog" aria-label="이름 표기 기준">
          <p className="naming-panel__title">이름 표기 기준</p>
          {NAME_KINDS.map((kind) => (
            <label key={kind} className="naming-panel__row">
              <span>{NAME_KIND_LABEL[kind]} 이름</span>
              <span className={`naming-panel__count${(kind === 'table' ? offTables : offColumns) ? ' off' : ''}`} title="이 기준과 다른 이름 수 (설계 검사 '이름 표기 기준과 다름'에서 보고 고칩니다). 밑줄로 시작하는 도구용 테이블은 빼고 셉니다">
                {info[kind].style ? ((kind === 'table' ? offTables : offColumns) ? `다름 ${kind === 'table' ? offTables : offColumns}` : '모두 맞음') : ''}
              </span>
              <select value={info[kind].saved ?? ''} onChange={(e) => choose(kind, e.target.value)} aria-label={`${NAME_KIND_LABEL[kind]} 이름 표기`}>
                <option value="">{info[kind].style ? `자동 — ${NAME_STYLE_LABEL[info[kind].style!]}${info[kind].from === 'dictionary' ? ' (사전)' : ''}` : '자동'}</option>
                {NAME_STYLES.map((st) => <option key={st} value={st}>{NAME_STYLE_LABEL[st]} (예: {NAME_STYLE_EXAMPLE[st]})</option>)}
              </select>
            </label>
          ))}
          <div className="naming-panel__quick">
            <span className="muted small">한 번에:</span>
            {NAME_STYLES.map((st) => (
              <button key={st} className={savedTable === st && savedColumn === st ? 'active' : ''} onClick={() => both(st)}>
                {NAME_STYLE_LABEL[st]}
              </button>
            ))}
            <button onClick={() => both('')}>자동</button>
          </div>
          <p className="muted small naming-panel__help">
            테이블과 컬럼을 다르게 둘 수 있습니다 (예: 테이블 camelCase, 컬럼 snake_case). 자동은 용어 사전의 표기, 사전이 없으면 지금 많이 쓰는 표기를 따릅니다.
          </p>
        </div>
      )}
    </div>
  );
}
