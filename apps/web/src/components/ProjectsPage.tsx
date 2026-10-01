import { useEffect, useState } from 'react';
import type { DialectId } from '@erd/core';
import { projectApi, type ProjectInfo } from '../lib/api';
import { clearLegacyProject, legacyProject, useStore } from '../store';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [dialect, setDialect] = useState<DialectId>('mysql');
  const [legacy, setLegacy] = useState(legacyProject);
  const userName = useStore((s) => s.userName);

  const load = async () => {
    try {
      setProjects(await projectApi.list());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    document.title = 'ERD';
    load();
  }, []);

  const create = async (body: Parameters<typeof projectApi.create>[0]) => {
    const p = await projectApi.create(body);
    location.hash = `#/p/${p.id}`;
  };

  return (
    <div className="projects-page">
      <header className="projects-page__head">
        <h1>ERD</h1>
        <p className="muted">함께 그리고, DB와 바로 동기화하고, AI와 같이 설계하는 ERD</p>
        <label className="inline-field">
          내 이름 (함께 작업할 때 표시)
          <input value={userName} onChange={(e) => useStore.getState().setUserName(e.target.value)} placeholder="예: 홍길동" />
        </label>
      </header>

      {legacy && (
        <div className="legacy-box">
          <div>이 브라우저에만 저장된 ERD "<b>{legacy.name}</b>" (테이블 {legacy.schema.tables.length}개)가 있습니다.</div>
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" onClick={async () => { await create(legacy); clearLegacyProject(); }}>서버 프로젝트로 옮기기</button>
            <button className="btn btn-sm" onClick={() => { if (confirm('브라우저에 남은 ERD를 지울까요?')) { clearLegacyProject(); setLegacy(null); } }}>지우기</button>
          </div>
        </div>
      )}

      <form
        className="new-project"
        onSubmit={(e) => {
          e.preventDefault();
          create({ name: name.trim() || '새 프로젝트', dialect });
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="새 프로젝트 이름" />
        <select value={dialect} onChange={(e) => setDialect(e.target.value as DialectId)}>
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
        </select>
        <button className="btn btn-primary" type="submit">만들기</button>
      </form>

      {error && <div className="error-box">{error}</div>}
      {projects && projects.length === 0 && <div className="empty-state">프로젝트가 없습니다. 새로 만들거나, 만든 뒤 "DB에서 가져오기"로 기존 DB를 불러오세요.</div>}
      <ul className="project-list">
        {projects?.map((p) => (
          <li key={p.id}>
            <a href={`#/p/${p.id}`}>
              <b>{p.name}</b>
              <span className="muted small">
                {p.dialect === 'postgresql' ? 'PostgreSQL' : 'MySQL'} · 테이블 {p.tableCount ?? 0}개 · {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ''}
              </span>
            </a>
            <button
              className="icon-btn danger"
              title="삭제"
              onClick={async () => {
                if (!confirm(`"${p.name}" 프로젝트를 삭제할까요? 버전과 제안도 함께 지워지며 되돌릴 수 없습니다.`)) return;
                await projectApi.remove(p.id);
                load();
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
