import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  addMissingTerms,
  checkColumnAgainstDictionary,
  clearDictionary,
  detectStyle,
  dictIndex,
  dictionaryFromSchema,
  duplicatePhysicals,
  dictKey,
  logicalFillsFromSchema,
  mergedTerms,
  NAME_STYLE_LABEL,
  newTermsFromColumns,
  removeDictEntry,
  searchDictionary,
  setDictEntry,
  styleSuggestion,
  termKey,
  toStyle,
  updateColumn,
  writeDictionary,
  type DictTerm,
  type DictVariant,
  type Dictionary,
  type NameStyle,
} from '@erd/core';
import { useStore } from '../store';
import { loadModule } from '../lib/appVersion';
import { downloadBlob, safeFileName } from '../lib/download';
import { useProjectName } from '../lib/hooks';
import { projectApi } from '../lib/api';
import { Modal } from './Modal';
import { Dropdown, Icon } from './ui';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** 목록에 한 번에 그리는 줄 수 (큰 사전에서 느려지지 않게) */
const PAGE = 200;

type Source = { id: string; name: string; terms: number };
/** 넣기 전에 고치는 한 줄 */
type Row = DictTerm & { id: number; include: boolean; variants: DictVariant[] };
/** 넣기 전 편집: 어디서 왔는지 + 줄들 */
type Staged = { from: string; rows: Row[]; notes: string[] };

const physKey = (p: string) => p.trim().toLowerCase();

/**
 * 표준 용어 사전: 엑셀로 올리거나(끌어다 놓기), 이 ERD에서 만들거나, 다른 프로젝트에서 복사한다.
 * 어디서 가져오든 "넣을 용어"를 목록에서 바로 고친 뒤 넣는다 (엑셀을 다시 받고 올릴 필요 없음).
 * 넣은 뒤에도 목록의 칸을 눌러 바로 고친다. 사전은 이 프로젝트에 저장되어 함께 쓰는 사람과 AI(MCP)가 같이 쓴다.
 */
export function DictionaryDialog({ onClose, onOpenLint }: { onClose: () => void; onOpenLint: () => void }) {
  const dictionary = useStore((s) => s.dictionary);
  const schema = useStore((s) => s.schema);
  const readOnly = useStore((s) => s.role === 'viewer');
  const { editDictionary, edit, showNotice } = useStore.getState();
  const projectName = useProjectName();
  const [staged, setStaged] = useState<Staged | null>(null);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [busy, setBusy] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const stage = (from: string, terms: (DictTerm & { variants?: DictVariant[] })[], notes: string[] = []) => {
    setSources(null);
    setStaged({ from, notes, rows: terms.map((t, i) => ({ ...t, logical: t.logical ?? '', id: i, include: true, variants: t.variants ?? [] })) });
  };

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
      stage(file.name, parsed.terms, parsed.notes);
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
      setStaged(null);
      setSources(found.flatMap((r) => (r.status === 'fulfilled' && r.value.d ? [{ id: r.value.p.id, name: r.value.p.name, terms: r.value.d.terms.length }] : [])));
    } catch (e) {
      alert(`프로젝트 목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  };
  // 고른 프로젝트 사전을 복사본으로 (원본과 연결되지 않음)
  const pickSource = async (source: Source) => {
    try {
      const d = (await projectApi.dictionary(source.id)).dictionary;
      if (!d) return alert('그 프로젝트에는 사전이 없습니다');
      stage(`${source.name} 프로젝트`, d.terms, ['복사본입니다 — 원본 프로젝트의 사전을 나중에 고쳐도 여기는 바뀌지 않습니다']);
    } catch (e) {
      alert(`사전을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const buildFromErd = () => {
    const rows = dictionaryFromSchema(useStore.getState().schema);
    if (!rows.length) return alert('ERD에 컬럼이 없습니다.');
    stage('이 ERD', rows, ['컬럼마다 가장 많이 쓰는 이름·타입을 골라 두었습니다. "다르게 쓴 곳"에서 다른 것을 고를 수 있습니다', '논리명이 없는 컬럼도 넣습니다 — 나중에 채우면 됩니다', '여기서 물리명·타입을 고쳐도 ERD 컬럼은 그대로입니다. 넣은 뒤 "표준대로 모두 맞추기"로 ERD를 사전에 맞출 수 있습니다']);
  };
  const applyStaged = (terms: DictTerm[], mode: 'replace' | 'merge') => {
    let count = 0;
    if (!editDictionary((d) => void (count = writeDictionary(d, { terms }, mode)))) return;
    setStaged(null);
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
  if (staged) {
    body = <StagedEditor staged={staged} onChange={setStaged} current={dictionary?.terms ?? []} onApply={applyStaged} onCancel={() => setStaged(null)} />;
  } else if (sources) {
    body = <SourcesView sources={sources} onPick={(s) => void pickSource(s)} onBack={() => setSources(null)} />;
  } else if (!dictionary) {
    body = (
      <>
        <p className="dict-lead">
          회사 표준 용어를 넣어 두면 컬럼을 입력할 때 <b>물리명·논리명·타입이 표준대로 채워지고</b>, 다르게 쓴 곳은 설계 검사에서 알려 줍니다. AI(MCP)도 이 사전대로 설계합니다.
        </p>
        {!readOnly && (
          <button className="dict-drop" onClick={openFile} disabled={Boolean(busy)}>
            <Icon name="download" size={28} />
            <b>{busy || '엑셀 파일을 여기에 끌어다 놓거나 눌러서 고르세요'}</b>
            <span className="muted small">회사 양식 그대로 됩니다 — 머리글(용어명·논리명 / 영문약어명·물리명 / 데이터타입 / 길이 / 설명)로 칸을 찾습니다. 올린 뒤 목록에서 바로 고칠 수 있습니다</span>
          </button>
        )}
        <div className="dict-alt">
          {!readOnly && (
            <button className="dict-alt__card" disabled={!schema.tables.length} onClick={buildFromErd}>
              <b>이 ERD에서 만들기</b>
              <span className="muted small">지금 컬럼들로 목록을 만들고, 바로 고쳐서 넣습니다</span>
            </button>
          )}
          {!readOnly && (
            <button className="dict-alt__card" disabled={Boolean(busy)} onClick={() => void findSources()}>
              <b>다른 프로젝트에서 복사</b>
              <span className="muted small">이미 사전을 넣은 프로젝트의 것을 가져옵니다</span>
            </button>
          )}
          <button className="dict-alt__card" onClick={() => void download(true)}>
            <b>빈 양식 받기</b>
            <span className="muted small">표준용어 시트와 예시가 든 엑셀</span>
          </button>
        </div>
        <p className="muted small dict-style-help">물리명 표기(snake_case·SNAKE_CASE·camelCase)는 용어들로 자동으로 정합니다. 한 사전 안에서 표기가 섞이면 넣을 수 없습니다.</p>
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
          <button className="btn btn-sm" onClick={() => void download(false)} title="지금 사전을 엑셀로 받습니다">엑셀로 내려받기</button>
          <Dropdown
            label="더보기"
            items={[
              { label: '이 ERD에서 만들기', hint: '컬럼들로 목록을 만들어 합치기', disabled: readOnly || !schema.tables.length, onClick: buildFromErd },
              { label: '다른 프로젝트에서 복사', hint: '복사본으로 가져오기', disabled: readOnly, onClick: () => void findSources() },
              { label: '빈 양식 받기', hint: '예시가 든 엑셀', onClick: () => void download(true) },
              { label: '사전 비우기', hint: 'ERD는 그대로', disabled: readOnly, onClick: () => confirm('표준 용어 사전을 모두 지울까요? (ERD는 바뀌지 않습니다)') && editDictionary((d) => clearDictionary(d)) },
            ]}
          />
        </div>
        <ErdCheck
          dictionary={dictionary}
          readOnly={readOnly}
          onOpenLint={onOpenLint}
          onFixAll={(n, run) => {
            if (!confirm(`표준과 다른 컬럼 ${n}개의 물리명·타입·길이를 사전대로 바꿀까요?\n\n이미 DB에 있는 컬럼이면 "DB로 내보내기"에서 컬럼 이름·타입 변경(ALTER)이 생깁니다. Ctrl+Z로 한 번에 되돌릴 수 있습니다.`)) return;
            edit(run);
            showNotice({ text: `${n}개 컬럼을 표준대로 맞췄습니다 (Ctrl+Z로 되돌리기)` });
          }}
        />
        <DuplicateNotice terms={dictionary.terms} />
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
            <b>놓으면 엑셀을 읽어 목록으로 보여 드립니다</b>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 예전에 넣어 같은 물리명을 쓰는 용어가 있으면 알린다 (지금은 새로 넣을 때 막는다) */
function DuplicateNotice({ terms }: { terms: DictTerm[] }) {
  const groups = useMemo(() => duplicatePhysicals(terms), [terms]);
  if (!groups.length) return null;
  return (
    <div className="dict-check warn-box">
      <span>
        같은 물리명을 쓰는 용어가 {groups.length}곳 있습니다 — 하나만 남기거나 물리명을 고쳐 주세요:{' '}
        {groups.slice(0, 5).map((g) => `${g[0].physical} (${g.map((t) => t.logical || '논리명 없음').join('·')})`).join(', ')}
        {groups.length > 5 ? ' …' : ''}
      </span>
    </div>
  );
}

/** 사전 표기 표시: snake_case 등 (용어들로 판단) */
function StyleBadge({ terms }: { terms: DictTerm[] }) {
  const { style } = detectStyle(terms);
  if (!style) return null;
  return <span className="dict-style-badge" title="사전 용어들의 물리명을 보고 정했습니다. 새 용어도 이 표기로만 넣을 수 있고, 사전에 없는 컬럼이 다른 표기면 설계 검사에서 경고합니다">{NAME_STYLE_LABEL[style]}</span>;
}

type Filter = 'all' | 'variants' | 'noLogical' | 'style' | 'dup';

/**
 * 넣기 전 편집 목록 (엑셀·이 ERD·다른 프로젝트 공통): 칸을 바로 고치고, 뺄 것은 체크를 풀고, 넣는다.
 * 표기가 섞였거나 물리명·논리명이 겹치면 넣을 수 없고, 그 줄을 표시한다 ("모두 ○○로 바꾸기"로 한 번에 맞출 수 있음).
 */
function StagedEditor({ staged, onChange, current, onApply, onCancel }: {
  staged: Staged; onChange: (s: Staged) => void; current: DictTerm[]; onApply: (terms: DictTerm[], mode: 'replace' | 'merge') => void; onCancel: () => void;
}) {
  const hasDictionary = current.length > 0;
  // 이미 사전이 있으면 기본은 합치기 (무심코 넣어도 기존 용어가 지워지지 않게)
  const [mode, setMode] = useState<'replace' | 'merge'>('merge');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const rows = staged.rows;
  const included = rows.filter((r) => r.include && r.physical.trim());
  const terms: DictTerm[] = included.map(({ id: _id, include: _inc, variants: _v, ...t }) => t);

  // 넣은 뒤의 사전으로 표기·겹침을 본다 (합치기면 기존 용어까지)
  const problems = useMemo(() => {
    const result = mergedTerms(current, terms, hasDictionary ? mode : 'replace');
    const check = detectStyle(result);
    const offKeys = new Set(check.offenders.map((t) => termKey(t)));
    const byPhys = new Map<string, number>();
    for (const t of result) byPhys.set(physKey(t.physical), (byPhys.get(physKey(t.physical)) ?? 0) + 1);
    const logicals = new Map<string, number>();
    for (const r of included) if (r.logical.trim()) logicals.set(dictKey(r.logical), (logicals.get(dictKey(r.logical)) ?? 0) + 1);
    const styleOff = included.filter((r) => offKeys.has(termKey(r)));
    const dup = included.filter((r) => (byPhys.get(physKey(r.physical)) ?? 0) > 1 || (r.logical.trim() && (logicals.get(dictKey(r.logical)) ?? 0) > 1));
    return { style: check.style, styleOff: new Set(styleOff.map((r) => r.id)), dup: new Set(dup.map((r) => r.id)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, current, mode, hasDictionary]);

  const counts: Record<Filter, number> = {
    all: rows.length,
    variants: rows.filter((r) => r.variants.length > 1).length,
    noLogical: rows.filter((r) => r.include && !r.logical.trim()).length,
    style: problems.styleOff.size,
    dup: problems.dup.size,
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'variants' && r.variants.length < 2) return false;
      if (filter === 'noLogical' && (!r.include || r.logical.trim())) return false;
      if (filter === 'style' && !problems.styleOff.has(r.id)) return false;
      if (filter === 'dup' && !problems.dup.has(r.id)) return false;
      return !q || r.logical.toLowerCase().includes(q) || r.physical.toLowerCase().includes(q);
    });
  }, [rows, filter, query, problems]);

  const update = (id: number, patch: Partial<Row>) => onChange({ ...staged, rows: rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const fixAllStyle = (style: NameStyle) => onChange({ ...staged, rows: rows.map((r) => (problems.styleOff.has(r.id) ? { ...r, physical: toStyle(r.physical, style) } : r)) });
  const blocked = counts.style > 0 || counts.dup > 0 || !included.length;

  return (
    <div className="dict-step">
      <div className="dict-step__head">
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>← 취소</button>
        <h3>넣을 용어 확인·편집 · {staged.from}</h3>
      </div>
      <div className="dict-stats">
        <div><b>{included.length.toLocaleString()}</b><span>넣을 용어 (전체 {rows.length.toLocaleString()})</span></div>
        {problems.style && <div className={counts.style ? 'warn' : ''}><b>{NAME_STYLE_LABEL[problems.style]}</b><span>{counts.style ? `다른 표기 ${counts.style}개` : '물리명 표기 (자동 판단)'}</span></div>}
        {counts.noLogical > 0 && <div className="muted"><b>{counts.noLogical}</b><span>논리명 없음 (나중에 채워도 됨)</span></div>}
      </div>
      {staged.notes.length > 0 && <ul className="dict-notes">{staged.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {(counts.style > 0 || counts.dup > 0) && (
        <div className="safety-box fail">
          {counts.style > 0 && (
            <div>
              <b>표기가 섞여 있습니다</b> — 대부분 {NAME_STYLE_LABEL[problems.style!]}인데 다른 표기가 {counts.style}개 있습니다. 칸에서 고치거나{' '}
              <button className="btn btn-sm" onClick={() => fixAllStyle(problems.style!)}>모두 {NAME_STYLE_LABEL[problems.style!]}로 바꾸기</button>
            </div>
          )}
          {counts.dup > 0 && <div><b>같은 물리명·논리명이 {counts.dup}줄에 겹칩니다</b> — 하나만 남기도록 고치거나 체크를 풀어 주세요{hasDictionary && mode === 'merge' ? ' (지금 사전의 용어와 겹치는 것 포함)' : ''}.</div>}
        </div>
      )}
      <div className="dict-tabs">
        <div className="segmented small">
          {([['all', '전체'], ['variants', '다르게 쓴 곳'], ['noLogical', '논리명 없음'], ['style', '다른 표기'], ['dup', '겹침']] as [Filter, string][]).map(([f, label]) =>
            f === 'all' || counts[f] ? (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => { setFilter(f); setLimit(PAGE); }}>{label} {counts[f]}</button>
            ) : null,
          )}
        </div>
        <input type="search" className="dict-search" placeholder="논리명·물리명 찾기" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
      </div>
      <div className="dict-table-wrap tall">
        <table className="dict-table edit">
          <thead>
            <tr>
              <th className="narrow">
                <input
                  type="checkbox"
                  title="보이는 줄 모두 넣기/빼기"
                  checked={filtered.length > 0 && filtered.every((r) => r.include)}
                  onChange={(e) => {
                    const ids = new Set(filtered.map((r) => r.id));
                    onChange({ ...staged, rows: rows.map((r) => (ids.has(r.id) ? { ...r, include: e.target.checked } : r)) });
                  }}
                />
              </th>
              <th>논리명</th><th>물리명</th><th>타입</th><th>길이</th><th>설명</th><th>쓰는 곳</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((r) => {
              const bad = problems.styleOff.has(r.id) ? 'style' : problems.dup.has(r.id) ? 'dup' : '';
              return (
                <tr key={r.id} className={`${r.include ? '' : 'excluded'}${bad ? ` bad-${bad}` : ''}`}>
                  <td className="narrow"><input type="checkbox" checked={r.include} onChange={(e) => update(r.id, { include: e.target.checked })} /></td>
                  <td><input value={r.logical} placeholder="(논리명 없음)" onChange={(e) => update(r.id, { logical: e.target.value })} /></td>
                  <td>
                    <input
                      className="mono"
                      value={r.physical}
                      title={bad === 'style' ? `사전 표기(${NAME_STYLE_LABEL[problems.style!]})와 다릅니다 → ${toStyle(r.physical, problems.style!)}` : bad === 'dup' ? '다른 줄(또는 지금 사전)과 물리명·논리명이 겹칩니다' : undefined}
                      onChange={(e) => update(r.id, { physical: e.target.value })}
                    />
                  </td>
                  <td><input className="mono" value={r.type ?? ''} onChange={(e) => update(r.id, { type: e.target.value })} /></td>
                  <td><input className="mono" value={r.length ?? ''} onChange={(e) => update(r.id, { length: e.target.value })} /></td>
                  <td><input value={r.description ?? ''} onChange={(e) => update(r.id, { description: e.target.value })} /></td>
                  <td className="uses">
                    {r.variants.length > 1 ? (
                      <select
                        title="이 논리명을 다르게 쓴 곳 — 고르면 그 이름·타입으로"
                        value=""
                        onChange={(e) => {
                          const v = r.variants[Number(e.target.value)];
                          if (v) update(r.id, { physical: v.physical, type: v.type || undefined, length: v.length || undefined });
                        }}
                      >
                        <option value="">다르게 쓴 곳 {r.variants.length}가지 ▾</option>
                        {r.variants.map((v, i) => (
                          <option key={i} value={i}>{v.physical} {v.type}{v.length ? `(${v.length})` : ''} ×{v.columns.length}</option>
                        ))}
                      </select>
                    ) : r.variants.length === 1 ? (
                      <span className="muted small" title={r.variants[0].columns.join('\n')}>{r.variants[0].columns.length}곳</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="muted small dict-empty">해당하는 줄이 없습니다.</p>}
        {filtered.length > limit && <button className="btn btn-sm dict-more" onClick={() => setLimit((n) => n + PAGE)}>{(filtered.length - limit).toLocaleString()}줄 더 보기</button>}
      </div>
      {hasDictionary && (
        <div className="dict-mode">
          <label className={mode === 'merge' ? 'active' : ''}>
            <input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            <span><b>합치기</b><span className="muted small">같은 용어만 새 내용으로 바꾸고 나머지는 그대로</span></span>
          </label>
          <label className={mode === 'replace' ? 'active' : ''}>
            <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} />
            <span><b>새로 바꾸기</b><span className="muted small">지금 사전을 지우고 이 목록으로</span></span>
          </label>
        </div>
      )}
      <div className="btn-row">
        <button className="btn btn-primary" disabled={blocked} onClick={() => onApply(terms, hasDictionary ? mode : 'replace')}>
          사전에 넣기 ({included.length.toLocaleString()})
        </button>
        <button className="btn" onClick={onCancel}>취소</button>
        {blocked && included.length > 0 && <span className="muted small">표기·겹침을 고치면 넣을 수 있습니다</span>}
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
          <p className="muted small">복사본으로 가져옵니다. 가져온 뒤 목록에서 고쳐서 넣을 수 있습니다.</p>
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

/** 지금 ERD가 사전을 얼마나 따르는지 + 한 번에 맞추기·사전에 넣기·논리명 채우기 */
function ErdCheck({ dictionary, readOnly, onOpenLint, onFixAll }: { dictionary: Dictionary; readOnly: boolean; onOpenLint: () => void; onFixAll: (n: number, run: Parameters<ReturnType<typeof useStore.getState>['edit']>[0]) => void }) {
  const schema = useStore((s) => s.schema);
  const { editDictionary, showNotice } = useStore.getState();
  const check = useMemo(() => {
    const index = dictIndex(dictionary);
    const mismatches: { tableId: string; columnId: string; patch: NonNullable<ReturnType<typeof checkColumnAgainstDictionary>>['patch'] }[] = [];
    let unknown = 0;
    let ok = 0;
    let style = 0;
    for (const t of schema.tables) {
      for (const c of t.columns) {
        const r = checkColumnAgainstDictionary(index, c);
        if (r?.status === 'ok') ok++;
        else if (r?.status === 'mismatch') mismatches.push({ tableId: t.id, columnId: c.id, patch: r.patch });
        else if (styleSuggestion(index, c.name)) style++;
        else if (r?.status === 'unknown') unknown++;
      }
    }
    const missing = newTermsFromColumns(index, schema.tables.flatMap((t) => t.columns.map((column) => ({ table: t.name, column })))).add;
    const fills = logicalFillsFromSchema(dictionary, schema);
    return { ok, unknown, style, mismatches, missing, fills };
  }, [dictionary, schema]);
  const addMissing = (terms: DictTerm[], what: string) => {
    let added: DictTerm[] = [];
    if (editDictionary((d) => void (added = addMissingTerms(d, terms)))) showNotice({ text: `용어 사전: ${added.length}개를 ${what}` });
  };
  return (
    <div className="dict-check">
      <span>
        이 ERD: 표준대로 <b>{check.ok}</b> · 표준과 다름 <b className={check.mismatches.length ? 'warn' : ''}>{check.mismatches.length}</b> · 사전에 없음 <b className={check.unknown ? 'warn' : ''}>{check.unknown}</b>
        {check.style > 0 && <> · 다른 표기 <b className="warn">{check.style}</b></>}
      </span>
      <span className="spacer" />
      {(check.mismatches.length > 0 || check.unknown > 0 || check.style > 0) && <button className="btn btn-sm" onClick={onOpenLint}>설계 검사에서 보기</button>}
      {check.missing.length > 0 && !readOnly && (
        <button className="btn btn-sm" title="사전에 없는 컬럼의 논리명·물리명·타입을 새 용어로 넣습니다 (사전 표기와 다르거나 물리명이 이미 있는 것은 빼고)" onClick={() => addMissing(check.missing, '새로 넣었습니다')}>
          사전에 없는 용어 추가 ({check.missing.length})
        </button>
      )}
      {check.fills.length > 0 && !readOnly && (
        <button className="btn btn-sm" title="논리명이 없는 사전 용어에, 같은 물리명을 쓰는 컬럼의 논리명을 채웁니다" onClick={() => addMissing(check.fills, 'ERD 논리명으로 채웠습니다')}>
          논리명 채우기 ({check.fills.length})
        </button>
      )}
      {check.mismatches.length > 0 && !readOnly && (
        <button className="btn btn-sm btn-primary" onClick={() => onFixAll(check.mismatches.length, (d) => check.mismatches.forEach((m) => updateColumn(d, m.tableId, m.columnId, m.patch!)))}>
          표준대로 모두 맞추기 ({check.mismatches.length})
        </button>
      )}
    </div>
  );
}

/** 사전 목록: 칸을 눌러 바로 고치고(Enter·칸 밖을 누르면 저장), 한 줄 추가·삭제, 찾기 */
function DictionaryTable({ dictionary, readOnly }: { dictionary: Dictionary; readOnly: boolean }) {
  const { editDictionary } = useStore.getState();
  const [query, setQuery] = useState('');
  const [onlyNoLogical, setOnlyNoLogical] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [form, setForm] = useState<DictTerm>({ logical: '', physical: '' });
  const noLogical = dictionary.terms.filter((t) => !t.logical).length;
  const shown = useMemo(() => {
    // 마지막 하나까지 채우면 필터 체크도 사라지므로 그때는 전체를 보인다
    const base = onlyNoLogical && noLogical > 0 ? dictionary.terms.filter((t) => !t.logical) : dictionary.terms;
    return searchDictionary(base, query, Number.MAX_SAFE_INTEGER);
  }, [dictionary.terms, query, onlyNoLogical, noLogical]);
  const addForm = () => {
    if (editDictionary((d) => setDictEntry(d, form))) setForm({ logical: '', physical: '' });
  };
  // 한 칸 고치기: 원래 용어(previous)를 새 값으로. 막히면(표기·겹침) 알리고 그대로 둔다
  const saveCell = (term: DictTerm, patch: Partial<DictTerm>) => {
    const next = { ...term, ...patch };
    if (JSON.stringify(next) === JSON.stringify(term)) return;
    editDictionary((d) => setDictEntry(d, next, term));
  };
  return (
    <>
      <div className="dict-tabs">
        <input type="search" className="dict-search" placeholder="논리명·물리명·설명 찾기" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
        {noLogical > 0 && (
          <label className="row-gap small" title="ERD에서 만들 때 논리명이 없던 용어 — 칸을 눌러 채우세요">
            <input type="checkbox" checked={onlyNoLogical} onChange={(e) => setOnlyNoLogical(e.target.checked)} /> 논리명 없는 것만 ({noLogical})
          </label>
        )}
      </div>
      {!readOnly && (
        <div className="dict-form">
          <input placeholder="논리명 (예: 회원번호)" value={form.logical} onChange={(e) => setForm({ ...form, logical: e.target.value })} />
          <input placeholder="물리명 (예: member_no)" value={form.physical} onChange={(e) => setForm({ ...form, physical: e.target.value })} />
          <input placeholder="타입" value={form.type ?? ''} onChange={(e) => setForm({ ...form, type: e.target.value })} />
          <input placeholder="길이" value={form.length ?? ''} onChange={(e) => setForm({ ...form, length: e.target.value })} />
          <input placeholder="설명" value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addForm()} />
          <button className="btn btn-sm btn-primary" disabled={!form.physical.trim()} onClick={addForm}>추가</button>
        </div>
      )}
      <div className="dict-table-wrap">
        <table className={`dict-table${readOnly ? '' : ' edit'}`}>
          <thead>
            <tr>
              <th>논리명</th><th>물리명</th><th>타입</th><th>길이</th><th>설명</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((e) => (
              <tr key={termKey(e)} className={e.logical ? '' : 'no-logical'}>
                {readOnly ? (
                  <>
                    <td>{e.logical || <span className="muted">(논리명 없음)</span>}</td>
                    <td className="mono">{e.physical}</td>
                    <td className="mono">{e.type}</td>
                    <td className="mono">{e.length}</td>
                    <td className="muted">{e.description}</td>
                    <td />
                  </>
                ) : (
                  <>
                    <td><CellInput value={e.logical} placeholder="(논리명 없음 — 눌러서 입력)" onCommit={(v) => saveCell(e, { logical: v })} /></td>
                    <td><CellInput className="mono" value={e.physical} onCommit={(v) => v && saveCell(e, { physical: v })} /></td>
                    <td><CellInput className="mono" value={e.type ?? ''} onCommit={(v) => saveCell(e, { type: v || undefined })} /></td>
                    <td><CellInput className="mono" value={e.length ?? ''} onCommit={(v) => saveCell(e, { length: v || undefined })} /></td>
                    <td><CellInput value={e.description ?? ''} onCommit={(v) => saveCell(e, { description: v || undefined })} /></td>
                    <td>
                      <button
                        className="icon-btn danger"
                        title="삭제"
                        onClick={() => {
                          if (!editDictionary((d) => removeDictEntry(d, e))) return;
                          useStore.getState().showNotice({ text: `용어를 지웠습니다: ${e.logical || '(논리명 없음)'} = ${e.physical}`, action: { label: '되돌리기', run: () => void editDictionary((d) => setDictEntry(d, e)) } });
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="muted small dict-empty">찾는 항목이 없습니다.</p>}
        {shown.length > limit && <button className="btn btn-sm dict-more" onClick={() => setLimit((n) => n + PAGE)}>{(shown.length - limit).toLocaleString()}개 더 보기</button>}
      </div>
    </>
  );
}

/** 목록 칸: 고치는 동안은 그 칸만, Enter·칸 밖을 누르면 저장, Esc 취소 */
function CellInput({ value, onCommit, className, placeholder }: { value: string; onCommit: (v: string) => void; className?: string; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(null);
          setTimeout(() => (e.target as HTMLInputElement).blur(), 0);
        }
      }}
    />
  );
}
