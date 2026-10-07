import { useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { addIndex, autoFixColumnPatch, findTable, LINT_RULES, lintSchema, removeRelation, reviewItemState, unreviewedTables, updateColumn, type AiReviewItem, type AiReviewState, type LintIssue, type LintRule, type Schema } from '@erd/core';
import { useStore } from '../store';
import { useProjectName } from '../lib/hooks';
import { Dropdown, Icon } from './ui';
import { cancelAiHere, checkAiAvailable, runAiHere, useAiRun, type AiMode } from '../lib/aiRunner';

/** AI 검토 항목 중 지금 보여 줄 것 (열림·다시 확인 필요, 대상 테이블이 지워진 것은 뺀다) */
function openReviewItems(items: AiReviewItem[] | undefined, schema: Schema): (AiReviewItem & { state: AiReviewState })[] {
  return (items ?? []).filter((i) => i.status === 'open').map((i) => ({ ...i, state: reviewItemState(i, schema) })).filter((i) => i.state !== 'missing');
}

/** 설계 문제 수 (도구 막대 배지용: 오류+경고, 기본 검사 + AI 검토) */
export function useLintCount(): number {
  const schema = useStore((s) => s.schema);
  const dialect = useStore((s) => s.meta.dialect);
  const ignored = useStore((s) => s.meta.lintIgnored);
  const review = useStore((s) => s.meta.aiReview);
  return useMemo(() => {
    const skip = new Set(ignored ?? []);
    const basic = lintSchema(schema, dialect).filter((i) => i.severity !== 'info' && !skip.has(i.id)).length;
    const ai = openReviewItems(review?.items, schema).filter((i) => i.severity !== 'info' && !skip.has(i.id)).length;
    return basic + ai;
  }, [schema, dialect, ignored, review]);
}

/** AI 검토 이후 바뀐 테이블 수 (검토를 한 번도 안 한 프로젝트는 0 — AI를 안 쓰는 프로젝트에 계속 뜨지 않게) */
export function useReviewPending(): number {
  const schema = useStore((s) => s.schema);
  const review = useStore((s) => s.meta.aiReview);
  return useMemo(() => unreviewedTables(schema, review)?.length ?? 0, [schema, review]);
}

/** AI에게 보낼 문장을 복사하고 화면 아래에 알린다 */
async function copyForAi(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useStore.getState().showNotice({ text: 'AI에게 보낼 문장을 복사했습니다. Claude 등 MCP를 연결한 AI 대화창에 붙여넣으세요.' });
  } catch {
    prompt('AI에게 보낼 문장 (복사해서 쓰세요)', text);
  }
}

const SEV_LABEL: Record<AiReviewItem['severity'], string> = { error: '오류', warning: '경고', info: '참고' };

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
  // AI 검토 (MCP로 연결한 AI가 저장한 것)
  const review = useStore((s) => s.meta.aiReview);
  const reviewAll = useMemo(() => openReviewItems(review?.items, schema), [review, schema]);
  const reviewItems = useMemo(() => reviewAll.filter((i) => !ignoredSet.has(i.id)), [reviewAll, ignoredSet]);
  const reviewIgnored = useMemo(() => reviewAll.filter((i) => ignoredSet.has(i.id)), [reviewAll, ignoredSet]);
  const reviewResolved = useMemo(() => (review?.items ?? []).filter((i) => i.status === 'resolved'), [review]);
  const [showResolved, setShowResolved] = useState(false);
  const [aiOpen, setAiOpen] = useState(true);
  // 마지막 AI 검토 뒤 새로 생기거나 바뀐 테이블 (검토가 밀린 것). 검토를 한 번도 안 했으면 null
  const pending = useMemo(() => (schema.tables.length ? unreviewedTables(schema, review) : []), [schema, review]);
  // 설치형 앱 + 이 PC에 Claude Code가 있으면 바로 실행, 아니면 문장 복사
  const projectId = useStore((s) => s.projectId);
  const otherRun = useStore((s) => s.meta.aiRun);
  const ai = useAiRun();
  useEffect(() => checkAiAvailable(), []);
  const runningHere = ai.running?.projectId === projectId ? ai.running : null;
  const result = ai.result?.projectId === projectId ? ai.result : null;
  const othersRunning = !runningHere && otherRun && Date.now() - Date.parse(otherRun.startedAt) < 30 * 60_000 ? otherRun : null;
  const runHere = (mode: AiMode) => {
    if (!projectId) return;
    void runAiHere({ projectId, projectName, mode, tables: pending?.length ? pending : undefined });
  };
  const [showIgnored, setShowIgnored] = useState(false);
  const setIgnored = (id: string, on: boolean) => {
    const next = new Set(ignoredIds ?? []);
    if (on) next.add(id);
    else next.delete(id);
    // 이미 고쳐져 없어진 항목의 무시 기록은 정리한다
    const live = new Set([...all.map((i) => i.id), ...(review?.items ?? []).map((i) => i.id)]);
    useStore.getState().setLintIgnored([...next].filter((x) => live.has(x)));
  };
  const [open, setOpen] = useState<Partial<Record<LintRule, boolean>>>({ 'no-primary-key': true, 'fk-type-mismatch': true, 'fk-without-index': true });

  const groups = useMemo(() => {
    const map = new Map<LintRule, LintIssue[]>();
    for (const i of issues) map.set(i.rule, [...(map.get(i.rule) ?? []), i]);
    return [...map.entries()];
  }, [issues]);
  const count = (sev: LintIssue['severity']) => issues.filter((i) => i.severity === sev).length + reviewItems.filter((i) => i.severity === sev).length;

  const go = (issue: LintIssue) => {
    const { select, setSearchFocus } = useStore.getState();
    select({ type: 'table', id: issue.tableId }, true);
    setSearchFocus({ tableId: issue.tableId, columnId: issue.columnId });
    fitView({ nodes: [{ id: issue.tableId }], padding: 0.8, duration: 350, maxZoom: 1.3 });
  };

  const goTable = (tableName: string, columnName?: string) => {
    const t = schema.tables.find((x) => x.name.toLowerCase() === tableName.toLowerCase());
    if (!t) return;
    const c = columnName ? t.columns.find((x) => x.name.toLowerCase() === columnName.toLowerCase()) : undefined;
    go({ tableId: t.id, columnId: c?.id } as LintIssue);
  };

  /** 검토만 요청하는 문장 (바뀐 테이블만, 또는 처음이면 전체) */
  const askReview = async () => {
    const scope = pending?.length ? pending : null;
    const target = scope ? `바뀐 테이블(${scope.join(', ')})과 그 관계 상대` : 'ERD 전체';
    const text = `ERD 프로젝트 "${projectName}"의 설계를 검토만 해줘. 아직 고치지는 마. erd MCP의 check_design으로 기본 검사와 지난 검토를 먼저 확인하고, ${target}를 검토해서 오류·경고·참고로 나눠 save_design_review로 저장해줘${scope ? ' (tables에 검토한 테이블 이름)' : ''}. 기본 검사에 이미 나온 내용은 넣지 말고 고치는 방법도 같이 적어줘. 저장한 뒤 등급별로 요약해서 알려줘.`;
    await copyForAi(text);
  };

  const askAi = async () => {
    const text = `ERD 프로젝트 "${projectName}"의 설계를 검토하고 고쳐줘. erd MCP의 check_design으로 문제를 확인하고(사람이 무시한 항목은 고치지 마) edit_schema로 고친 뒤, 고친 AI 검토 항목은 resolve_design_review로 해결 표시해줘. 마지막으로 설계를 다시 검토해 save_design_review로 저장하고, 오류·경고·참고별로 무엇을 고쳤는지 알려줘. 논리명은 한글로 넣어줘.`;
    await copyForAi(text);
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
      {/* AI 막대: AI 검토 상태 한 줄 + 요청 메뉴 하나 (검토만 / 검토하고 고치기 / 연결 방법) */}
      <div className={`lint-ai-bar${pending?.length ? ' lint-ai-bar--pending' : ''}`} title={pending?.length ? pending.join(', ') : undefined}>
        <Icon name="sparkles" size={13} />
        <span className="lint-ai-bar__text">
          {pending === null ? (
            <span className="muted">아직 AI 설계 검토가 없습니다</span>
          ) : pending.length > 0 ? (
            <>
              AI 검토 이후 바뀐 테이블 <b>{pending.length}개</b>
              <span className="muted"> · {pending.slice(0, 3).join(', ')}{pending.length > 3 ? ` 외 ${pending.length - 3}개` : ''}</span>
            </>
          ) : (
            <span className="muted">AI 검토 최신 · {review ? new Date(review.reviewedAt).toLocaleString() : ''}</span>
          )}
        </span>
        <Dropdown
          label="AI에게 요청"
          title="AI(MCP)에게 보낼 요청 문장을 복사합니다"
          items={
            ai.available
              ? [
                  { label: pending?.length ? '바뀐 테이블 검토' : '설계 검토', hint: `Claude로 바로 실행${pending?.length ? ` · ${pending.length}개` : ''}`, disabled: Boolean(ai.running) || readOnly, onClick: () => runHere('review') },
                  { label: '검토하고 고치기', hint: 'Claude로 바로 실행', disabled: Boolean(ai.running) || readOnly, onClick: () => runHere('fix') },
                  { label: '요청 문장만 복사', hint: '다른 AI에 붙여넣기', onClick: askReview },
                  { label: 'AI 연결 방법', onClick: onOpenAi },
                ]
              : [
                  { label: pending?.length ? '바뀐 테이블 검토' : '설계 검토', hint: pending?.length ? `문장 복사 · ${pending.length}개만` : '문장 복사', onClick: askReview },
                  { label: '검토하고 고치기', hint: '문장 복사', onClick: askAi },
                  { label: 'AI 연결 방법', onClick: onOpenAi },
                ]
          }
        />
      </div>
      {runningHere && (
        <div className="lint-ai-run">
          <span className="lint-ai-run__spinner" />
          <span className="grow">
            Claude가 {runningHere.mode === 'fix' ? '검토하고 고치는' : '검토하는'} 중 · <span className="muted">{runningHere.step}</span>
          </span>
          <button className="btn btn-ghost small" onClick={cancelAiHere}>취소</button>
        </div>
      )}
      {othersRunning && (
        <div className="lint-ai-run">
          <span className="lint-ai-run__spinner" />
          <span className="grow muted">{othersRunning.by}의 앱에서 AI {othersRunning.mode === 'fix' ? '검토·수정' : '검토'} 중</span>
        </div>
      )}
      {result && !runningHere && (
        <div className={`lint-ai-result${result.ok ? '' : ' lint-ai-result--error'}`}>
          <span className="lint-ai-result__text">{result.ok ? '✓ ' : '⚠ '}{result.summary || (result.ok ? '완료했습니다' : '실패했습니다')}</span>
          <button className="icon-btn" onClick={ai.clearResult} title="닫기"><Icon name="close" size={12} /></button>
        </div>
      )}
      {issues.length === 0 && reviewItems.length === 0 ? (
        <div className="lint-empty">
          <Icon name="check" size={20} />
          <p>{ignored.length || reviewIgnored.length ? '무시한 항목 외에는 문제가 없습니다.' : '문제가 없습니다.'}</p>
        </div>
      ) : (
        <div className="lint-groups">
          {reviewItems.length > 0 && (
            <section className="lint-group lint-group--ai">
              <button className="lint-group__head" onClick={() => setAiOpen(!aiOpen)} title="MCP로 연결한 AI가 설계를 검토해 남긴 항목입니다. 동의하지 않으면 무시하세요. AI는 무시한 항목을 고치지 않습니다.">
                <Icon name="sparkles" size={14} />
                <b>AI 검토</b>
                <span className="muted">{reviewItems.length}</span>
                <span className="muted small">{review ? new Date(review.reviewedAt).toLocaleString() : ''}</span>
                <span className="lint-group__chev">{aiOpen ? '▾' : '▸'}</span>
              </button>
              {aiOpen && (
                <>
                  {review?.summary && <p className="lint-group__desc">{review.summary}</p>}
                  <ul>
                    {reviewItems.map((item) => (
                      <li key={item.id} className="lint-ai-item">
                        <span className={`sev-dot sev-${item.severity}`} title={SEV_LABEL[item.severity]} />
                        <button className="lint-item" onClick={() => item.table && goTable(item.table, item.column)}>
                          <span className={`lint-sev-text sev-${item.severity}`}>{SEV_LABEL[item.severity]}</span>
                          {item.table ? <b className="lint-ai-target">{item.table}{item.column ? `.${item.column}` : ''}</b> : null}
                          {item.message}
                          {item.state === 'stale' && <span className="lint-stale" title="AI가 검토한 뒤 이 테이블이 바뀌었습니다. 지금도 문제인지 다시 확인하세요">다시 확인 필요</span>}
                          {item.suggestion && <span className="lint-ai-suggestion">→ {item.suggestion}</span>}
                        </button>
                        {!readOnly && (
                          <button className="btn btn-ghost small lint-ignore" title="동의하지 않는 항목: 목록·배지에서 숨기고, AI도 다음 작업에서 고치지 않습니다" onClick={() => setIgnored(item.id, true)}>
                            무시
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
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
                        {issue.fix?.kind === 'removeRelation' && !readOnly && (
                          <button
                            className="btn btn-ghost small"
                            title="중복된 관계 하나를 지웁니다. FK 컬럼은 남은 관계가 쓰므로 그대로 둡니다 (Ctrl+Z로 되돌리기)"
                            onClick={() => {
                              const { relationId } = issue.fix as Extract<LintIssue['fix'], { kind: 'removeRelation' }>;
                              useStore.getState().edit((d) => void removeRelation(d, relationId));
                            }}
                          >
                            중복 관계 지우기
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
      {reviewResolved.length > 0 && (
        <div className="lint-ignored">
          <button className="lint-group__head" onClick={() => setShowResolved(!showResolved)}>
            <span className="muted">AI가 해결한 항목 {reviewResolved.length}</span>
            <span className="lint-group__chev">{showResolved ? '▾' : '▸'}</span>
          </button>
          {showResolved && (
            <ul>
              {reviewResolved.map((item) => (
                <li key={item.id}>
                  <span className={`sev-dot sev-${item.severity}`} />
                  <span className="lint-item muted">
                    {SEV_LABEL[item.severity]} · {item.table ? `${item.table}${item.column ? `.${item.column}` : ''}: ` : ''}{item.message}
                    {item.resolution && <span className="lint-ai-suggestion">✓ {item.resolution}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {ignored.length + reviewIgnored.length > 0 && (
        <div className="lint-ignored">
          <button className="lint-group__head" onClick={() => setShowIgnored(!showIgnored)}>
            <span className="muted">무시한 항목 {ignored.length + reviewIgnored.length}</span>
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
              {reviewIgnored.map((item) => (
                <li key={item.id}>
                  <span className={`sev-dot sev-${item.severity}`} />
                  <span className="lint-item muted">AI 검토 · {item.table ? `${item.table}: ` : ''}{item.message}</span>
                  {!readOnly && (
                    <button className="btn btn-ghost small" onClick={() => setIgnored(item.id, false)}>무시 취소</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
