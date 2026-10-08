import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  checkColumnAgainstDictionary,
  detectStyle,
  mergedTerms,
  mixedStyleMessage,
  NAME_STYLE_LABEL,
  type StyleCheck,
  clearDictionary,
  dictionaryFromSchema,
  dictIndex,
  removeDictEntry,
  searchDictionary,
  setDictEntry,
  splitDictType,
  updateColumn,
  writeDictionary,
  type DictConflict,
  type DictTerm,
  type Dictionary,
} from '@erd/core';
import type { DictionaryImport } from '@erd/core/dictionary-excel';
import { useStore } from '../store';
import { loadModule } from '../lib/appVersion';
import { downloadBlob, safeFileName } from '../lib/download';
import { useProjectName } from '../lib/hooks';
import { projectApi } from '../lib/api';
import { Modal } from './Modal';
import { Dropdown, Icon } from './ui';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Entry = { logical: string; physical: string; type?: string; length?: string; description?: string };
type Pending = DictionaryImport & { file: string };
type Draft = { terms: DictTerm[]; conflicts: DictConflict[]; skipped: number };
type Source = { id: string; name: string; terms: number };

/** 사전 표기 표시: "snake_case (자동 판단)" */
function StyleBadge({ terms }: { terms: DictTerm[] }) {
  const { style } = detectStyle(terms);
  if (!style) return null;
  return <span className="dict-style-badge" title="사전 용어들의 물리명을 보고 정했습니다. 새 용어도 이 표기로만 넣을 수 있고, 사전에 없는 컬럼이 다른 표기면 설계 검사에서 경고합니다">{NAME_STYLE_LABEL[style]}</span>;
}

/**
 * 표준 용어 사전: 엑셀로 올리고(끌어다 놓기 가능), 찾아보고, 몇 개는 직접 고친다.
 * 사전은 이 프로젝트에 저장되어 함께 쓰는 사람과 AI(MCP)가 같이 쓴다. SQL·DB에는 영향이 없다.
 * 화면은 한 번에 한 가지: 처음 시작 / 사전 보기 / 올릴 내용 확인 / ERD 초안 / 다른 프로젝트 고르기
 */
export function DictionaryDialog({ onClose, onOpenLint }: { onClose: () => void; onOpenLint: () => void }) {
  const dictionary = useStore((s) => s.dictionary);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer');
  const { editDictionary, edit, showNotice } = useStore.getState();
  const projectName = useProjectName();
  const [pending, setPending] = useState<Pending | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [busy, setBusy] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // ── 가져오기 ─────────────────────────────
  const pickFile = async (file: File) => {
    if (!/\.xlsx$/i.test(file.name)) return alert('엑셀 파일(.xlsx)만 올릴 수 있습니다');
    setBusy('엑셀 읽는 중…');
    try {
      const { parseDictionaryWorkbook } = await loadModule(() => import('@erd/core/dictionary-excel'));
      const parsed = await parseDictionaryWorkbook(await file.arrayBuffer());
      if (!parsed.terms.length) {
        alert(`읽을 용어가 없습니다.\n${parsed.notes.join('\n')}\n\n머리글에 "논리명(용어명)"과 "물리명(영문약어명)" 칸이 있어야 합니다. "빈 양식 받기"로 받은 파일을 참고하세요.`);
        return;
      }
      setDraft(null);
      setSources(null);
      setMode('replace');
      setPending({ ...parsed, file: file.name });
    } catch (e) {
      alert(`엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };
  const openFile = () => fileInput.current?.click();
  const findSources = async () => {
    setBusy('다른 프로젝트 찾는 중…');
    try {
      const current = useStore.getState().projectId;
      const projects = (await projectApi.list()).filter((p) => p.id !== current);
      const found = await Promise.allSettled(projects.map(async (p) => ({ p, d: (await projectApi.dictionary(p.id)).dictionary })));
      setDraft(null);
      setSources(found.flatMap((r) => (r.status === 'fulfilled' && r.value.d ? [{ id: r.value.p.id, name: r.value.p.name, terms: r.value.d.terms.length }] : [])));
    } catch (e) {
      alert(`프로젝트 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };
  // 고른 프로젝트 사전을 복사본으로 (원본과 연결되지 않음). 엑셀 올리기와 같은 확인 단계를 거친다
  const pickSource = async (source: Source) => {
    try {
      const d = (await projectApi.dictionary(source.id)).dictionary;
      if (!d) return alert('그 프로젝트에는 사전이 없습니다');
      setSources(null);
      setMode('replace');
      setPending({ terms: d.terms, notes: [`"${source.name}" 프로젝트 사전의 복사본입니다 (원본을 고쳐도 여기는 바뀌지 않음)`], file: `${source.name} 프로젝트` });
    } catch (e) {
      alert(`사전을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const buildFromErd = () => {
    const result = dictionaryFromSchema(useStore.getState().schema);
    if (!result.terms.length) return alert('논리명이 있는 컬럼이 없습니다. 컬럼에 논리명(한글 이름)을 넣으면 그걸로 사전을 만듭니다.');
    setSources(null);
    setDraft(result);
  };
  const downloadDraft = async () => {
    if (!draft) return;
    const { dictionaryWorkbook } = await loadModule(() => import('@erd/core/dictionary-excel'));
    const buf = await dictionaryWorkbook({ terms: draft.terms }, { conflicts: draft.conflicts });
    downloadBlob(new Blob([buf], { type: XLSX }), `${safeFileName(projectName)}_사전초안.xlsx`);
  };
  const useDraft = () => {
    if (!draft) return;
    setMode(dictionary ? 'merge' : 'replace');
    setPending({
      terms: draft.terms,
      notes: [`이 ERD 컬럼의 논리명 ${draft.terms.length}개로 만든 초안입니다`, ...(draft.conflicts.length ? [`다르게 쓴 ${draft.conflicts.length}개는 가장 많이 쓰는 이름·타입으로 넣습니다`] : [])],
      file: '이 ERD',
    });
    setDraft(null);
  };
  const applyImport = () => {
    if (!pending) return;
    let count = 0;
    const ok = editDictionary((d) => {
      count = writeDictionary(d, { terms: pending.terms }, mode);
    });
    if (!ok) return;
    setPending(null);
    showNotice({ text: `표준 용어 사전: 용어 ${count}개를 ${mode === 'replace' || !dictionary ? '넣었습니다' : '합쳤습니다'}` });
  };
  const download = async (template: boolean) => {
    const { dictionaryWorkbook } = await loadModule(() => import('@erd/core/dictionary-excel'));
    const buf = await dictionaryWorkbook(template ? null : dictionary);
    downloadBlob(new Blob([buf], { type: XLSX }), template ? '표준용어사전_양식.xlsx' : `${safeFileName(projectName)}_표준용어사전.xlsx`);
  };

  // ── 끌어다 놓기: 창 어디에 놓아도 올라간다 ─────────────────────────────
  const hasFile = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = readOnly
    ? {}
    : {
        onDragEnter: (e: DragEvent) => {
          if (!hasFile(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => hasFile(e) && e.preventDefault(),
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void pickFile(file);
        },
      };

  let body: ReactNode;
  if (pending) {
    body = <ImportPreview pending={pending} current={dictionary?.terms ?? []} mode={mode} onMode={setMode} onApply={applyImport} onCancel={() => setPending(null)} />;
  } else if (draft) {
    body = <DraftView draft={draft} onUse={useDraft} onDownload={() => void downloadDraft()} onBack={() => setDraft(null)} />;
  } else if (sources) {
    body = <SourcesView sources={sources} onPick={(s) => void pickSource(s)} onBack={() => setSources(null)} />;
  } else if (!dictionary) {
    body = (
      <>
        <p className="dict-lead">
          회사 표준 용어를 넣어 두면 컬럼 <b>논리명을 입력할 때 물리명·타입이 표준대로 채워지고</b>, 다르게 쓴 곳은 설계 검사에서 알려 줍니다. AI(MCP)도 이 사전대로 설계합니다.
        </p>
        {!readOnly && (
          <button className="dict-drop" onClick={openFile} disabled={Boolean(busy)}>
            <Icon name="download" size={28} />
            <b>{busy || '엑셀 파일을 여기에 끌어다 놓거나 눌러서 고르세요'}</b>
            <span className="muted small">회사 양식 그대로 됩니다 — 머리글(용어명·논리명 / 영문약어명·물리명 / 데이터타입 / 길이 / 설명)로 칸을 찾습니다</span>
          </button>
        )}
        <div className="dict-alt">
          <button className="dict-alt__card" onClick={() => void download(true)}>
            <b>빈 양식 받기</b>
            <span className="muted small">표준용어 시트와 예시가 든 엑셀</span>
          </button>
          {!readOnly && (
            <button className="dict-alt__card" disabled={!schema.tables.length} onClick={buildFromErd}>
              <b>이 ERD에서 만들기</b>
              <span className="muted small">지금 컬럼의 논리명·물리명·타입으로 초안을 만듭니다</span>
            </button>
          )}
          {!readOnly && (
            <button className="dict-alt__card" disabled={Boolean(busy)} onClick={() => void findSources()}>
              <b>다른 프로젝트에서 복사</b>
              <span className="muted small">이미 사전을 넣은 프로젝트의 것을 가져옵니다</span>
            </button>
          )}
        </div>
        <p className="muted small dict-style-help">물리명 표기(snake_case·SNAKE_CASE·camelCase)는 올린 용어들로 자동으로 정합니다. 한 사전 안에서 표기가 섞이면 올릴 수 없습니다.</p>
      </>
    );
  } else {
    body = (
      <>
        <div className="dict-summary">
          <span>
            표준 용어 <b>{dictionary.terms.length.toLocaleString()}</b>개 <StyleBadge terms={dictionary.terms} />
            {dictionary.updatedAt && <span className="muted small"> · {new Date(dictionary.updatedAt).toLocaleString()} 수정</span>}
          </span>
          <span className="spacer" />
          {!readOnly && <button className="btn btn-sm btn-primary" disabled={Boolean(busy)} onClick={openFile} title="엑셀 파일을 이 창에 끌어다 놓아도 됩니다">{busy || '엑셀 올리기'}</button>}
          <button className="btn btn-sm" onClick={() => void download(false)} title="지금 사전을 엑셀로 받습니다. 고친 뒤 다시 올리면 됩니다">엑셀로 내려받기</button>
          <Dropdown
            label="더보기"
            items={[
              { label: '이 ERD에서 만들기', hint: '컬럼 논리명으로 초안', disabled: readOnly || !schema.tables.length, onClick: buildFromErd },
              { label: '다른 프로젝트에서 복사', hint: '복사본으로 가져오기', disabled: readOnly, onClick: () => void findSources() },
              { label: '빈 양식 받기', hint: '예시가 든 엑셀', onClick: () => void download(true) },
              { label: '사전 비우기', hint: 'ERD는 그대로', disabled: readOnly, onClick: () => confirm('표준 용어 사전을 모두 지울까요? (ERD는 바뀌지 않습니다)') && editDictionary((d) => clearDictionary(d)) },
            ]}
          />
        </div>
        <ErdCheck dictionary={dictionary} readOnly={readOnly} onOpenLint={onOpenLint} onFixAll={(n, run) => {
          if (!confirm(`표준과 다른 컬럼 ${n}개의 물리명·타입·길이를 사전대로 바꿀까요?\n\n이미 DB에 있는 컬럼이면 "DB로 내보내기"에서 컬럼 이름·타입 변경(ALTER)이 생깁니다. Ctrl+Z로 한 번에 되돌릴 수 있습니다.`)) return;
          edit(run);
          showNotice({ text: `${n}개 컬럼을 표준대로 맞췄습니다 (Ctrl+Z로 되돌리기)` });
        }} />
        <DictionaryTable dictionary={dictionary} readOnly={readOnly} />
        {!readOnly && <p className="muted small dict-drop-hint">엑셀 파일을 이 창에 끌어다 놓아도 올라갑니다.</p>}
      </>
    );
  }

  return (
    <Modal title="표준 용어 사전" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>닫기</button>}>
      <div className={`dict-root${dragging ? ' dragging' : ''}`} {...dropProps}>
        <input ref={fileInput} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickFile(f); }} />
        {body}
        {dragging && (
          <div className="dict-drop-overlay">
            <Icon name="download" size={32} />
            <b>놓으면 엑셀을 읽어 올릴 내용을 보여 드립니다</b>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 올릴 내용 확인: 몇 개인지, 표기(자동 판단)와 섞임, 바꾸기/합치기 */
function ImportPreview({ pending, current, mode, onMode, onApply, onCancel }: {
  pending: Pending; current: DictTerm[]; mode: 'replace' | 'merge'; onMode: (m: 'replace' | 'merge') => void; onApply: () => void; onCancel: () => void;
}) {
  const hasDictionary = current.length > 0;
  // 넣은 뒤의 사전 표기 (합치기면 기존 용어까지)
  const check: StyleCheck = useMemo(() => detectStyle(mergedTerms(current, pending.terms, hasDictionary ? mode : 'replace')), [current, pending, mode, hasDictionary]);
  const mixed = check.offenders.length > 0;
  return (
    <div className="dict-step">
      <div className="dict-step__head">
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>← 취소</button>
        <h3>올릴 내용 확인 · {pending.file}</h3>
      </div>
      <div className="dict-stats">
        <div><b>{pending.terms.length.toLocaleString()}</b><span>표준 용어</span></div>
        {check.style && <div className={mixed ? 'warn' : ''}><b>{NAME_STYLE_LABEL[check.style]}</b><span>{mixed ? `다른 표기 ${check.offenders.length}개 섞임` : '물리명 표기 (자동 판단)'}</span></div>}
      </div>
      {pending.notes.length > 0 && <ul className="dict-notes">{pending.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {mixed ? (
        <div className="safety-box fail">
          <b>표기가 섞여 있어 올릴 수 없습니다</b>
          <p className="small">{mixedStyleMessage(check)}</p>
          <ul className="dict-offenders">
            {check.offenders.slice(0, 20).map((t) => (
              <li key={t.logical}><span>{t.logical}</span> <code>{t.physical}</code></li>
            ))}
          </ul>
          {check.offenders.length > 20 && <p className="muted small">… 외 {check.offenders.length - 20}개</p>}
        </div>
      ) : (
        pending.terms.length > 0 && (
          <table className="dict-table compact">
            <thead><tr><th>논리명</th><th>물리명</th><th>타입</th><th>설명</th></tr></thead>
            <tbody>
              {pending.terms.slice(0, 5).map((t) => {
                const st = splitDictType(t.type, t.length);
                return (
                  <tr key={t.logical}>
                    <td>{t.logical}</td>
                    <td className="mono">{t.physical}</td>
                    <td className="mono">{st.type ? `${st.type}${st.length ? `(${st.length})` : ''}` : ''}</td>
                    <td className="muted">{t.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
      {hasDictionary && (
        <div className="dict-mode">
          <label className={mode === 'replace' ? 'active' : ''}>
            <input type="radio" checked={mode === 'replace'} onChange={() => onMode('replace')} />
            <span><b>새로 바꾸기</b><span className="muted small">지금 사전을 지우고 이 내용으로</span></span>
          </label>
          <label className={mode === 'merge' ? 'active' : ''}>
            <input type="radio" checked={mode === 'merge'} onChange={() => onMode('merge')} />
            <span><b>합치기</b><span className="muted small">같은 논리명만 새 내용으로 덮어쓰고 나머지는 그대로</span></span>
          </label>
        </div>
      )}
      <div className="btn-row">
        <button className="btn btn-primary" disabled={mixed} onClick={onApply}>사전에 넣기</button>
        <button className="btn" onClick={onCancel}>{mixed ? '닫고 고쳐서 다시 올리기' : '취소'}</button>
      </div>
    </div>
  );
}

/** 이 ERD로 만든 초안: 다르게 쓴 곳(충돌)과 두 가지 진행 방법 */
function DraftView({ draft, onUse, onDownload, onBack }: { draft: Draft; onUse: () => void; onDownload: () => void; onBack: () => void }) {
  const check = useMemo(() => detectStyle(draft.terms), [draft]);
  const mixed = check.offenders.length > 0;
  return (
    <div className="dict-step">
      <div className="dict-step__head">
        <button className="btn btn-sm btn-ghost" onClick={onBack}>← 뒤로</button>
        <h3>이 ERD로 만든 사전 초안</h3>
      </div>
      <div className="dict-stats">
        <div><b>{draft.terms.length.toLocaleString()}</b><span>표준 용어</span></div>
        <div className={draft.conflicts.length ? 'warn' : ''}><b>{draft.conflicts.length}</b><span>다르게 쓴 곳</span></div>
        {draft.skipped > 0 && <div className="muted"><b>{draft.skipped}</b><span>논리명 없어 뺀 컬럼</span></div>}
        {check.style && <div className={mixed ? 'warn' : ''}><b>{NAME_STYLE_LABEL[check.style]}</b><span>{mixed ? `다른 표기 ${check.offenders.length}개 섞임` : '물리명 표기'}</span></div>}
      </div>
      {mixed && (
        <div className="safety-box fail">
          <b>이 ERD의 컬럼 이름 표기가 섞여 있어 바로 넣을 수 없습니다</b>
          <p className="small">"엑셀로 받아 고치기"로 받아 표준용어 시트의 물리명을 한 가지 표기로 맞춘 뒤 다시 올려 주세요. 다른 표기: {check.offenders.slice(0, 10).map((t) => t.physical).join(', ')}{check.offenders.length > 10 ? ' …' : ''}</p>
        </div>
      )}
      {draft.conflicts.length > 0 ? (
        <>
          <p className="small">같은 논리명인데 이름·타입이 다른 곳입니다. <b>굵은 것</b>(가장 많이 쓰는 것)이 사전에 들어갑니다. 마우스를 올리면 쓰는 곳이 보입니다.</p>
          <ul className="dict-conflicts">
            {draft.conflicts.slice(0, 30).map((c) => (
              <li key={c.logical}>
                <span className="dict-conflicts__term">{c.logical}</span>
                <span className="dict-conflicts__variants">
                  {c.variants.map((v, i) => (
                    <span key={i} className={i === 0 ? 'chosen' : ''} title={v.columns.join('\n')}>
                      {v.physical} {v.type}{v.length ? `(${v.length})` : ''} ×{v.columns.length}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {draft.conflicts.length > 30 && <p className="muted small">나머지 {draft.conflicts.length - 30}개는 엑셀의 "충돌(검토)" 시트에서 보세요.</p>}
        </>
      ) : (
        <p className="muted small">같은 논리명끼리 이름·타입이 모두 같습니다.</p>
      )}
      <div className="dict-choices">
        <button className="dict-choice primary" disabled={mixed} onClick={onUse}>
          <b>바로 사전에 넣기</b>
          <span>굵게 표시된 이름·타입으로 넣습니다</span>
        </button>
        <button className="dict-choice" onClick={onDownload}>
          <b>엑셀로 받아 고치기</b>
          <span>"표준용어" 시트에서 원하는 표준으로 고친 뒤, 이 창에 끌어다 놓아 다시 올립니다</span>
        </button>
      </div>
    </div>
  );
}

function SourcesView({ sources, onPick, onBack }: { sources: Source[]; onPick: (s: Source) => void; onBack: () => void }) {
  return (
    <div className="dict-step">
      <div className="dict-step__head">
        <button className="btn btn-sm btn-ghost" onClick={onBack}>← 뒤로</button>
        <h3>다른 프로젝트에서 복사</h3>
      </div>
      {sources.length === 0 ? (
        <p className="empty-state small">사전이 있는 다른 프로젝트가 없습니다.</p>
      ) : (
        <>
          <p className="muted small">복사본으로 가져옵니다. 원본 프로젝트의 사전을 나중에 고쳐도 여기는 바뀌지 않습니다.</p>
          <ul className="dict-sources">
            {sources.map((src) => (
              <li key={src.id}>
                <span>{src.name}</span>
                <span className="muted small">용어 {src.terms}개</span>
                <button className="btn btn-sm" onClick={() => onPick(src)}>가져오기</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** 지금 ERD가 사전을 얼마나 따르는지 + 한 번에 맞추기 */
function ErdCheck({ dictionary, readOnly, onOpenLint, onFixAll }: { dictionary: Dictionary; readOnly: boolean; onOpenLint: () => void; onFixAll: (n: number, run: Parameters<ReturnType<typeof useStore.getState>['edit']>[0]) => void }) {
  const schema = useStore((s) => s.schema);
  const check = useMemo(() => {
    const index = dictIndex(dictionary);
    const mismatches: { tableId: string; columnId: string; patch: NonNullable<ReturnType<typeof checkColumnAgainstDictionary>>['patch'] }[] = [];
    let unknown = 0;
    let ok = 0;
    for (const t of schema.tables) {
      for (const c of t.columns) {
        const r = checkColumnAgainstDictionary(index, c);
        if (!r) continue;
        if (r.status === 'ok') ok++;
        else if (r.status === 'unknown') unknown++;
        else mismatches.push({ tableId: t.id, columnId: c.id, patch: r.patch });
      }
    }
    return { ok, unknown, mismatches };
  }, [dictionary, schema]);
  return (
    <div className="dict-check">
      <span>이 ERD: 표준대로 <b>{check.ok}</b> · 표준과 다름 <b className={check.mismatches.length ? 'warn' : ''}>{check.mismatches.length}</b> · 사전에 없음 <b>{check.unknown}</b></span>
      <span className="spacer" />
      {(check.mismatches.length > 0 || check.unknown > 0) && <button className="btn btn-sm" onClick={onOpenLint}>설계 검사에서 보기</button>}
      {check.mismatches.length > 0 && !readOnly && (
        <button className="btn btn-sm btn-primary" onClick={() => onFixAll(check.mismatches.length, (d) => check.mismatches.forEach((m) => updateColumn(d, m.tableId, m.columnId, m.patch!)))}>
          표준대로 모두 맞추기 ({check.mismatches.length})
        </button>
      )}
    </div>
  );
}

/** 용어 목록: 찾기, 한 줄 추가·고치기·삭제 */
function DictionaryTable({ dictionary, readOnly }: { dictionary: Dictionary; readOnly: boolean }) {
  const { editDictionary } = useStore.getState();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<Entry & { previous?: string }>({ logical: '', physical: '' });
  const shown = useMemo(() => searchDictionary(dictionary.terms, query, 300), [dictionary.terms, query]);
  const saveForm = () => {
    const entry: DictTerm = { logical: form.logical, physical: form.physical, type: form.type, length: form.length, description: form.description };
    if (editDictionary((d) => setDictEntry(d, entry, form.previous))) setForm({ logical: '', physical: '' });
  };
  return (
    <>
      <div className="dict-tabs">
        <input type="search" className="dict-search" placeholder="논리명·물리명·설명 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!readOnly && (
        <div className="dict-form">
          <input placeholder="논리명 (예: 회원번호)" value={form.logical} onChange={(e) => setForm({ ...form, logical: e.target.value })} />
          <input placeholder="물리명 (예: MBR_NO)" value={form.physical} onChange={(e) => setForm({ ...form, physical: e.target.value })} />
          <input placeholder="타입" value={form.type ?? ''} onChange={(e) => setForm({ ...form, type: e.target.value })} />
          <input placeholder="길이" value={form.length ?? ''} onChange={(e) => setForm({ ...form, length: e.target.value })} />
          <input placeholder="설명" value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveForm()} />
          <button className="btn btn-sm btn-primary" disabled={!form.logical.trim() || !form.physical.trim()} onClick={saveForm}>{form.previous ? '고치기' : '추가'}</button>
          {form.previous && <button className="btn btn-sm" onClick={() => setForm({ logical: '', physical: '' })}>취소</button>}
        </div>
      )}
      <div className="dict-table-wrap">
        <table className="dict-table">
          <thead>
            <tr>
              <th>논리명</th><th>물리명</th><th>타입</th><th>길이</th><th>설명</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.logical} className={form.previous === e.logical ? 'editing' : ''} onClick={() => !readOnly && setForm({ ...e, previous: e.logical })} title={readOnly ? undefined : '누르면 위 칸에서 고칠 수 있습니다'}>
                <td>{e.logical}</td>
                <td className="mono">{e.physical}</td>
                <td className="mono">{e.type}</td>
                <td className="mono">{e.length}</td>
                <td className="muted">{e.description}</td>
                <td>
                  {!readOnly && (
                    <button className="icon-btn danger" title="삭제" onClick={(ev) => { ev.stopPropagation(); editDictionary((d) => removeDictEntry(d, e.logical)); }}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted small dict-empty">찾는 항목이 없습니다.</p>}
        {shown.length >= 300 && <p className="muted small dict-empty">앞의 300개만 보입니다. 검색어로 좁혀 보세요.</p>}
      </div>
    </>
  );
}
