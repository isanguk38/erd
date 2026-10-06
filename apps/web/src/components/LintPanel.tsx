import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addIndex, autoFixColumnPatch, findTable, LINT_RULES, lintSchema, updateColumn, type LintIssue, type LintRule } from '@erd/core';
import { useStore } from '../store';
import { useProjectName } from '../lib/hooks';
import { Icon } from './ui';

/** 설계 문제 수 (도구 막대 배지용: 오류+경고) */
export function useLintCount(): number {
  const schema = useStore((s) => s.schema);
  const dialect = useStore((s) => s.meta.dialect);
  const ignored = useStore((s) => s.meta.lintIgnored);
  return useMemo(() => {
    const skip = new Set(ignored ?? []);
    return lintSchema(schema, dialect).filter((i) => i.severity !== 'info' && !skip.has(i.id)).length;
  }, [schema, dialect, ignored]);
}

/** 타입 검사의 고치기: 그 고침 때문에 생기는 문제(예: BIGINT로 바꾸면 남는 길이)도 함께 바로잡는다 */
function applyColumnFix(issue: LintIssue) {
  if (issue.fix?.kind !== 'patchColumn') return;
  const { tableId, columnId, patch } = issue.fix;
  const { schema, meta, edit } = useStore.getState();
  const column = findTable(schema, tableId)?.columns.find((c) => c.id === columnId);
  if (!column) return;
  const fixed = autoFixColumnPatch(meta.dialect || 'mysql', column, patch);
  edit((d) => updateColumn(d, tableId, columnId, fixed.patch));
}

/** 설계 검사 결과. 항목을 누르면 그 테이블로 이동한다 */
export function LintPanel({ onClose, onOpenAi }: { onClose: () => void; onOpenAi: () => void }) {
  const schema = useStore((s) => s.schema);
  const dialect = useStore((s) => s.meta.dialect);
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  const projectName = useProjectName();
  const { fitView } = useReactFlow();
  const ignoredIds = useStore((s) => s.meta.lintIgnored);
  const all = useMemo(() => lintSchema(schema, dialect), [schema, dialect]);
  // 무시한 항목은 목록·배지에서 빼고 아래 "무시한 항목"에 모은다
  const ignoredSet = useMemo(() => new Set(ignoredIds ?? []), [ignoredIds]);
  const issues = useMemo(() => all.filter((i) => !ignoredSet.has(i.id)), [all, ignoredSet]);
  const ignored = useMemo(() => all.filter((i) => ignoredSet.has(i.id)), [all, ignoredSet]);
  const [showIgnored, setShowIgnored] = useState(false);
  const setIgnored = (id: string, on: boolean) => {
    const next = new Set(ignoredIds ?? []);
    if (on) next.add(id);
    else next.delete(id);
    // 이미 고쳐져 없어진 항목의 무시 기록은 정리한다
    const live = new Set(all.map((i) => i.id));
    useStore.getState().setLintIgnored([...next].filter((x) => live.has(x)));
  };
  const [open, setOpen] = useState<Partial<Record<LintRule, boolean>>>({ 'no-primary-key': true, 'fk-type-mismatch': true, 'fk-without-index': true });
  const [copied, setCopied] = useState(false);

  const groups = useMemo(() => {
    const map = new Map<LintRule, LintIssue[]>();
    for (const i of issues) map.set(i.rule, [...(map.get(i.rule) ?? []), i]);
    return [...map.entries()];
  }, [issues]);
  const count = (sev: LintIssue['severity']) => issues.filter((i) => i.severity === sev).length;

  const go = (issue: LintIssue) => {
    const { select, setSearchFocus } = useStore.getState();
    select({ type: 'table', id: issue.tableId }, true);
    setSearchFocus({ tableId: issue.tableId, columnId: issue.columnId });
    fitView({ nodes: [{ id: issue.tableId }], padding: 0.8, duration: 350, maxZoom: 1.3 });
  };

  const askAi = async () => {
    const text = `ERD 프로젝트 "${projectName}"의 설계 검사 결과를 고쳐줘. erd MCP의 check_design으로 문제를 확인하고 edit_schema로 고친 뒤, check_design을 다시 호출해 남은 문제를 알려줘. 논리명은 한글로 넣어줘.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 4000);
    } catch {
      prompt('AI에게 보낼 문장 (복사해서 쓰세요)', text);
    }
  };

  return (
    <div className="lint-panel" role="dialog" aria-label="설계 검사">
      <div className="lint-panel__head">
        <h3>설계 검사</h3>
        <span className="lint-summary">
          <span className="sev sev-error">오류 {count('error')}</span>
          <span className="sev sev-warning">경고 {count('warning')}</span>
          <span className="sev sev-info">참고 {count('info')}</span>
        </span>
        <button className="icon-btn" onClick={onClose} title="닫기"><Icon name="close" size={14} /></button>
      </div>
      {issues.length === 0 ? (
        <div className="lint-empty">
          <Icon name="check" size={20} />
          <p>{ignored.length ? '무시한 항목 외에는 문제가 없습니다.' : '문제가 없습니다.'}</p>
        </div>
      ) : (
        <div className="lint-groups">
          {groups.map(([rule, list]) => (
            <section key={rule} className="lint-group">
              <button className="lint-group__head" onClick={() => setOpen((o) => ({ ...o, [rule]: !o[rule] }))} title={LINT_RULES[rule].description}>
                <span className={`sev-dot sev-${LINT_RULES[rule].severity}`} />
                <b>{LINT_RULES[rule].label}</b>
                <span className="muted">{list.length}</span>
                <span className="lint-group__chev">{open[rule] ? '▾' : '▸'}</span>
              </button>
              {open[rule] && (
                <>
                  <p className="lint-group__desc">{LINT_RULES[rule].description}</p>
                  <ul>
                    {list.map((issue) => (
                      <li key={issue.id}>
                        <button className="lint-item" onClick={() => go(issue)}>{issue.message}</button>
                        {!readOnly && (
                          <button className="btn btn-ghost small lint-ignore" title="이 항목을 목록과 배지에서 숨깁니다 (아래 '무시한 항목'에서 되살릴 수 있음)" onClick={() => setIgnored(issue.id, true)}>
                            무시
                          </button>
                        )}
                        {issue.fix?.kind === 'addIndex' && !readOnly && (
                          <button
                            className="btn btn-ghost small"
                            title="이 외래키 컬럼에 인덱스를 추가합니다"
                            onClick={() => {
                              const fix = issue.fix as Extract<LintIssue['fix'], { kind: 'addIndex' }>;
                              useStore.getState().edit((d) => void addIndex(d, fix.tableId, { columnIds: fix.columnIds }));
                            }}
                          >
                            인덱스 추가
                          </button>
                        )}
                        {issue.fix?.kind === 'patchColumn' && !readOnly && (
                          <button className="btn btn-ghost small" title="이 컬럼을 고칩니다 (Ctrl+Z로 되돌리기)" onClick={() => applyColumnFix(issue)}>
                            {issue.fix.label}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ))}
        </div>
      )}
      {ignored.length > 0 && (
        <div className="lint-ignored">
          <button className="lint-group__head" onClick={() => setShowIgnored(!showIgnored)}>
            <span className="muted">무시한 항목 {ignored.length}</span>
            <span className="lint-group__chev">{showIgnored ? '▾' : '▸'}</span>
          </button>
          {showIgnored && (
            <ul>
              {ignored.map((issue) => (
                <li key={issue.id}>
                  <span className={`sev-dot sev-${issue.severity}`} />
                  <button className="lint-item muted" onClick={() => go(issue)}>{issue.message}</button>
                  {!readOnly && (
                    <button className="btn btn-ghost small" onClick={() => setIgnored(issue.id, false)}>무시 취소</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="lint-panel__foot">
        <button className="btn" onClick={askAi} disabled={!issues.length} title="AI(MCP)에게 보낼 요청 문장을 복사합니다">
          <Icon name="sparkles" />
          {copied ? '복사됨 — AI에 붙여넣으세요' : 'AI에게 고쳐 달라고 하기'}
        </button>
        <button className="btn btn-ghost small" onClick={onOpenAi}>AI 연결 방법</button>
      </div>
    </div>
  );
}
