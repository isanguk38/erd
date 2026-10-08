import { useMemo, useState } from 'react';
import {
  checkColumnAgainstDictionary,
  clearDictionary,
  dictionaryFromSchema,
  dictIndex,
  removeDictEntry,
  searchDictionary,
  setDictCase,
  setDictEntry,
  updateColumn,
  writeDictionary,
  type DictCase,
  type DictConflict,
  type DictTerm,
  type DictWord,
} from '@erd/core';
import type { DictionaryImport } from '@erd/core/dictionary-excel';
import { useStore } from '../store';
import { loadModule } from '../lib/appVersion';
import { downloadBlob, safeFileName } from '../lib/download';
import { useProjectName } from '../lib/hooks';
import { projectApi } from '../lib/api';
import { Modal } from './Modal';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CASES: { id: DictCase; label: string }[] = [
  { id: 'asis', label: '사전 그대로' },
  { id: 'lower', label: '소문자 (mbr_no)' },
  { id: 'upper', label: '대문자 (MBR_NO)' },
];

type Kind = 'terms' | 'words';
type Entry = { logical: string; physical: string; type?: string; length?: string; description?: string };

/**
 * 표준 용어 사전: 엑셀로 올리고, 찾아보고, 몇 개는 직접 고친다.
 * 사전은 이 프로젝트에 저장되어 함께 쓰는 사람과 AI(MCP)가 같이 쓴다. SQL·DB에는 영향이 없다.
 */
export function DictionaryDialog({ onClose, onOpenLint }: { onClose: () => void; onOpenLint: () => void }) {
  const dictionary = useStore((s) => s.dictionary);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer');
  const { editDictionary, edit, showNotice } = useStore.getState();
  const projectName = useProjectName();
  const [kind, setKind] = useState<Kind>('terms');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<(DictionaryImport & { file: string; case?: DictCase }) | null>(null);
  // 다른 프로젝트 사전 (복사해 오기). null이면 아직 안 찾음
  const [sources, setSources] = useState<{ id: string; name: string; terms: number; words: number }[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  // 지금 ERD로 만든 사전 초안
  const [draft, setDraft] = useState<{ terms: DictTerm[]; conflicts: DictConflict[]; skipped: number } | null>(null);
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Entry & { previous?: string }>({ logical: '', physical: '' });

  // 지금 ERD가 사전을 얼마나 따르는지
  const check = useMemo(() => {
    if (!dictionary) return null;
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

  const entries: Entry[] = dictionary ? (kind === 'terms' ? dictionary.terms : dictionary.words) : [];
  const shown = useMemo(() => searchDictionary(entries, query, 300), [entries, query]);

  const pickFile = async (file: File) => {
    setBusy(true);
    try {
      const { parseDictionaryWorkbook } = await loadModule(() => import('@erd/core/dictionary-excel'));
      const parsed = await parseDictionaryWorkbook(await file.arrayBuffer());
      if (!parsed.terms.length && !parsed.words.length) {
        alert(`읽을 용어가 없습니다.\n${parsed.notes.join('\n')}\n\n머리글에 "논리명(용어명)"과 "물리명(영문약어명)" 칸이 있어야 합니다. "양식 받기"로 받은 파일을 참고하세요.`);
        return;
      }
      setPending({ ...parsed, file: file.name });
    } catch (e) {
      alert(`엑셀을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  // 내가 볼 수 있는 다른 프로젝트 중 사전이 있는 것
  const findSources = async () => {
    setLoadingSources(true);
    try {
      const current = useStore.getState().projectId;
      const projects = (await projectApi.list()).filter((p) => p.id !== current);
      const found = await Promise.allSettled(projects.map(async (p) => ({ p, d: (await projectApi.dictionary(p.id)).dictionary })));
      setSources(
        found.flatMap((r) => (r.status === 'fulfilled' && r.value.d ? [{ id: r.value.p.id, name: r.value.p.name, terms: r.value.d.terms.length, words: r.value.d.words.length }] : [])),
      );
    } catch (e) {
      alert(`프로젝트 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingSources(false);
    }
  };
  // 고른 프로젝트 사전을 복사본으로 가져온다 (원본과 연결되지 않음). 엑셀 올리기와 같은 확인 단계를 거친다
  const pickSource = async (source: { id: string; name: string }) => {
    try {
      const d = (await projectApi.dictionary(source.id)).dictionary;
      if (!d) return alert('그 프로젝트에는 사전이 없습니다');
      setPending({ terms: d.terms, words: d.words, notes: [`"${source.name}" 프로젝트 사전의 복사본입니다 (원본을 고쳐도 여기는 바뀌지 않음)`], file: `${source.name} 프로젝트`, case: d.case });
      setSources(null);
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
    const buf = await dictionaryWorkbook({ terms: draft.terms, words: [], case: 'asis' }, { conflicts: draft.conflicts });
    downloadBlob(new Blob([buf], { type: XLSX }), `${safeFileName(projectName)}_사전초안.xlsx`);
  };
  const useDraft = () => {
    if (!draft) return;
    setPending({
      terms: draft.terms,
      words: [],
      notes: [
        `이 ERD 컬럼의 논리명 ${draft.terms.length}개로 만든 초안입니다`,
        ...(draft.conflicts.length ? [`충돌 ${draft.conflicts.length}개는 가장 많이 쓰는 이름·타입으로 넣습니다`] : []),
      ],
      file: '이 ERD',
    });
    setDraft(null);
  };
  const applyImport = () => {
    if (!pending) return;
    let counts = { terms: 0, words: 0 };
    // 용어나 단어 시트가 없으면 그쪽은 그대로 둔다
    const ok = editDictionary((d) => {
      counts = writeDictionary(
        d,
        {
          ...(pending.terms.length ? { terms: pending.terms } : {}),
          ...(pending.words.length ? { words: pending.words } : {}),
          // 다른 프로젝트에서 가져오면 물리명 대소문자 설정도 (합치기면 지금 설정 유지)
          ...(pending.case && (mode === 'replace' || !dictionary) ? { case: pending.case } : {}),
        },
        mode,
      );
    });
    if (!ok) return;
    setPending(null);
    showNotice({ text: `표준 용어 사전: 용어 ${counts.terms}개 · 단어 ${counts.words}개를 ${mode === 'replace' ? '새로 넣었습니다' : '합쳤습니다'}` });
  };
  const download = async (template: boolean) => {
    const { dictionaryWorkbook } = await loadModule(() => import('@erd/core/dictionary-excel'));
    const buf = await dictionaryWorkbook(template ? null : dictionary);
    downloadBlob(new Blob([buf], { type: XLSX }), template ? '표준용어사전_양식.xlsx' : `${safeFileName(projectName)}_표준용어사전.xlsx`);
  };
  const saveForm = () => {
    const entry = kind === 'terms' ? ({ logical: form.logical, physical: form.physical, type: form.type, length: form.length, description: form.description } as DictTerm) : ({ logical: form.logical, physical: form.physical, description: form.description } as DictWord);
    if (editDictionary((d) => setDictEntry(d, kind, entry, form.previous))) setForm({ logical: '', physical: '' });
  };
  const fixAll = () => {
    if (!check?.mismatches.length) return;
    if (!confirm(`표준과 다른 컬럼 ${check.mismatches.length}개의 물리명·타입·길이를 사전대로 바꿀까요?\n\n이미 DB에 있는 컬럼이면 "DB로 내보내기"에서 컬럼 이름·타입 변경(ALTER)이 생깁니다. Ctrl+Z로 한 번에 되돌릴 수 있습니다.`)) return;
    edit((d) => check.mismatches.forEach((m) => updateColumn(d, m.tableId, m.columnId, m.patch!)));
    showNotice({ text: `${check.mismatches.length}개 컬럼을 표준대로 맞췄습니다 (Ctrl+Z로 되돌리기)` });
  };

  return (
    <Modal title="표준 용어 사전" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>닫기</button>}>
      <p className="muted small dict-intro">
        논리명(한글) → 표준 물리명·타입·길이. 컬럼 논리명을 입력하면 표준대로 채우고, 다르면 설계 검사에서 알려 줍니다. 용어에 없으면 표준 단어를 이어 붙여 물리명을 만듭니다 (상품+수량 → PRD_QTY).
        AI(MCP)도 설계할 때 이 사전을 찾아 씁니다. SQL·DB에는 영향이 없습니다.
      </p>

      <div className="dict-actions">
        {!readOnly && (
          <label className={`btn btn-primary${busy ? ' disabled' : ''}`}>
            {busy ? '읽는 중…' : '엑셀 올리기'}
            <input type="file" accept=".xlsx" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickFile(f); }} />
          </label>
        )}
        {!readOnly && (
          <button className="btn" disabled={!schema.tables.length} onClick={buildFromErd} title="지금 ERD 컬럼의 논리명·물리명·타입으로 사전 초안을 만듭니다 (같은 논리명인데 다르게 쓴 곳도 찾아 줌)">
            ERD에서 만들기
          </button>
        )}
        {!readOnly && (
          <button className="btn" disabled={loadingSources} onClick={() => void findSources()} title="내가 볼 수 있는 다른 프로젝트의 사전을 복사해 옵니다">
            {loadingSources ? '찾는 중…' : '다른 프로젝트에서 가져오기'}
          </button>
        )}
        <button className="btn" onClick={() => void download(true)} title="표준용어·표준단어 시트와 예시가 든 빈 양식">양식 받기</button>
        {dictionary && <button className="btn" onClick={() => void download(false)}>지금 사전 엑셀로 받기</button>}
        <span className="spacer" />
        {dictionary && (
          <label className="row-gap small">
            물리명 채우기
            <select value={dictionary.case} disabled={readOnly} onChange={(e) => editDictionary((d) => setDictCase(d, e.target.value as DictCase))}>
              {CASES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        {dictionary && !readOnly && (
          <button className="btn btn-ghost btn-danger-text" onClick={() => confirm('표준 용어 사전을 모두 지울까요? (ERD는 바뀌지 않습니다)') && editDictionary((d) => clearDictionary(d))}>사전 비우기</button>
        )}
      </div>

      {draft && (
        <div className="baseline-info dict-draft">
          <div>
            <b>이 ERD로 만든 사전 초안</b>: 용어 {draft.terms.length}개
            {draft.skipped > 0 && <span className="muted"> · 논리명이 없는 컬럼 {draft.skipped}개는 뺌</span>}
          </div>
          {draft.conflicts.length > 0 ? (
            <>
              <div className="dict-draft__warn">같은 논리명인데 이름·타입이 다른 곳 {draft.conflicts.length}개 — 사전에는 가장 많이 쓰는 것(굵게)이 들어갑니다</div>
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
              {draft.conflicts.length > 30 && <p className="muted small">나머지 {draft.conflicts.length - 30}개는 검토용 엑셀의 "충돌(검토)" 시트에서 보세요.</p>}
            </>
          ) : (
            <div className="muted">같은 논리명끼리 이름·타입이 모두 같습니다.</div>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" onClick={useDraft}>사전에 넣기</button>
            <button className="btn" onClick={() => void downloadDraft()} title="용어 시트 + 충돌(검토) 시트. 고친 뒤 '엑셀 올리기'로 다시 올리면 됩니다">검토용 엑셀 받기</button>
            <button className="btn" onClick={() => setDraft(null)}>닫기</button>
          </div>
        </div>
      )}

      {sources && (
        <div className="baseline-info dict-sources">
          {sources.length === 0 ? (
            <span>사전이 있는 다른 프로젝트가 없습니다.</span>
          ) : (
            <>
              <b>사전을 가져올 프로젝트</b>
              <ul>
                {sources.map((src) => (
                  <li key={src.id}>
                    <span>{src.name}</span>
                    <span className="muted small">용어 {src.terms}개 · 단어 {src.words}개</span>
                    <button className="btn btn-sm" onClick={() => void pickSource(src)}>가져오기</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="btn-row">
            <button className="btn btn-sm" onClick={() => setSources(null)}>닫기</button>
          </div>
        </div>
      )}

      {pending && (
        <div className="baseline-info dict-pending">
          <b>{pending.file}</b>: 용어 {pending.terms.length}개 · 단어 {pending.words.length}개
          <ul className="small">{pending.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          {dictionary && (
            <div className="radio-list">
              <label><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> 바꾸기 — 올린 시트의 기존 사전을 지우고 새로 넣기</label>
              <label><input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> 합치기 — 같은 논리명만 덮어쓰고 나머지는 두기</label>
            </div>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" onClick={applyImport}>사전에 넣기</button>
            <button className="btn" onClick={() => setPending(null)}>취소</button>
          </div>
        </div>
      )}

      {!dictionary && !pending && (
        <div className="empty-state small">
          아직 사전이 없습니다. 회사 표준 용어 엑셀을 그대로 올리거나 "양식 받기"로 받은 파일에 채워 올리세요.
          <br />머리글(용어명·논리명 / 영문약어명·물리명 / 데이터타입 / 길이 / 설명)로 칸을 찾고, 시트 이름에 "단어"가 있으면 표준 단어로 읽습니다.
        </div>
      )}

      {dictionary && check && (
        <div className="dict-check">
          <span>이 ERD: 표준대로 <b>{check.ok}</b> · 표준과 다름 <b className={check.mismatches.length ? 'warn' : ''}>{check.mismatches.length}</b> · 사전에 없음 <b>{check.unknown}</b></span>
          <span className="spacer" />
          {(check.mismatches.length > 0 || check.unknown > 0) && <button className="btn btn-sm" onClick={onOpenLint}>설계 검사에서 보기</button>}
          {check.mismatches.length > 0 && !readOnly && <button className="btn btn-sm btn-primary" onClick={fixAll}>표준대로 모두 맞추기 ({check.mismatches.length})</button>}
        </div>
      )}

      {dictionary && (
        <>
          <div className="dict-tabs">
            <div className="segmented">
              <button className={kind === 'terms' ? 'active' : ''} onClick={() => { setKind('terms'); setForm({ logical: '', physical: '' }); }}>표준 용어 {dictionary.terms.length}</button>
              <button className={kind === 'words' ? 'active' : ''} onClick={() => { setKind('words'); setForm({ logical: '', physical: '' }); }}>표준 단어 {dictionary.words.length}</button>
            </div>
            <input type="search" className="dict-search" placeholder="논리명·물리명·설명 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {!readOnly && (
            <div className={`dict-form${kind === 'words' ? ' words' : ''}`}>
              <input placeholder="논리명" value={form.logical} onChange={(e) => setForm({ ...form, logical: e.target.value })} />
              <input placeholder="물리명" value={form.physical} onChange={(e) => setForm({ ...form, physical: e.target.value })} />
              {kind === 'terms' && <input placeholder="타입" value={form.type ?? ''} onChange={(e) => setForm({ ...form, type: e.target.value })} />}
              {kind === 'terms' && <input placeholder="길이" value={form.length ?? ''} onChange={(e) => setForm({ ...form, length: e.target.value })} />}
              <input placeholder="설명" value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && saveForm()} />
              <button className="btn btn-sm btn-primary" disabled={!form.logical.trim() || !form.physical.trim()} onClick={saveForm}>{form.previous ? '고치기' : '추가'}</button>
              {form.previous && <button className="btn btn-sm" onClick={() => setForm({ logical: '', physical: '' })}>취소</button>}
            </div>
          )}
          <div className="dict-table-wrap">
            <table className="dict-table">
              <thead>
                <tr>
                  <th>논리명</th><th>물리명</th>{kind === 'terms' && <><th>타입</th><th>길이</th></>}<th>설명</th><th />
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.logical} onClick={() => !readOnly && setForm({ ...e, previous: e.logical })} title={readOnly ? undefined : '누르면 위 칸에서 고칠 수 있습니다'}>
                    <td>{e.logical}</td>
                    <td className="mono">{e.physical}</td>
                    {kind === 'terms' && <><td className="mono">{e.type}</td><td className="mono">{e.length}</td></>}
                    <td className="muted">{e.description}</td>
                    <td>
                      {!readOnly && (
                        <button className="icon-btn danger" title="삭제" onClick={(ev) => { ev.stopPropagation(); editDictionary((d) => removeDictEntry(d, kind, e.logical)); }}>×</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="muted small">찾는 항목이 없습니다.</p>}
            {shown.length >= 300 && <p className="muted small">앞의 300개만 보입니다. 검색어로 좁혀 보세요.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}
