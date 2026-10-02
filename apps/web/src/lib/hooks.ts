import { useCallback, useEffect, useRef, useState } from 'react';
import { getDialect, planPull, summarizePlan, type DialectId } from '@erd/core';
import { useStore } from '../store';
import { api, projectApi, type VersionInfo } from './api';
import { desktop } from './desktop';

export function useDialect(): DialectId {
  return useStore((s) => (s.meta.dialect || 'mysql') as DialectId);
}

export function useProjectName(): string {
  return useStore((s) => s.meta.name || 'ERD');
}

/** 서버에 저장된 버전 목록 */
export function useVersions() {
  const projectId = useStore((s) => s.projectId);
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setVersions(await projectApi.versions(projectId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { versions, error, reload };
}

/** 지금 화면의 스키마를 버전으로 저장한다 (실패해도 작업은 계속한다) */
export async function saveVersion(name: string, source: VersionInfo['source'] = 'manual'): Promise<void> {
  const { projectId, schema } = useStore.getState();
  if (!projectId) return;
  try {
    await projectApi.saveVersion(projectId, name, source, schema);
  } catch (e) {
    console.warn('버전 저장 실패', e);
  }
}

/** 버전 하나의 스키마를 불러온다 (비교용) */
export function useVersionSchema(versionId: string | null) {
  const projectId = useStore((s) => s.projectId);
  const [schema, setSchema] = useState<import('@erd/core').Schema | null>(null);
  useEffect(() => {
    setSchema(null);
    if (!projectId || !versionId) return;
    let alive = true;
    projectApi.version(projectId, versionId).then((v) => alive && setSchema(v.schema)).catch(() => alive && setSchema(null));
    return () => {
      alive = false;
    };
  }, [projectId, versionId]);
  return schema;
}

// ── DB 차이 알림 ─────────────────────────────

const statusListeners = new Set<() => void>();
/** 가져오기·내보내기 뒤 등에 DB 상태를 다시 확인하게 한다 */
export function refreshDbStatus(): void {
  statusListeners.forEach((fn) => fn());
}

const STATUS_INTERVAL = 3 * 60 * 1000;

/** 설치형 앱에서 마지막으로 읽은 DB 구조. ERD가 바뀌면 DB를 다시 읽지 않고 이것과 다시 비교한다. */
interface DesktopSnapshot {
  connection: { name: string; database: string };
  db: Awaited<ReturnType<typeof api.introspect>>;
  baseline: Awaited<ReturnType<typeof projectApi.baseline>>;
  checkedAt: string;
}

/** 설치형 앱: 사용자 PC에서 DB를 읽는다 (서버는 DB에 접속하지 않음) */
async function readDesktopSnapshot(projectId: string, connectionId: string): Promise<DesktopSnapshot | null> {
  const connections = await api.listConnections();
  const connection = connections.find((c) => c.id === connectionId);
  // 이 프로젝트에 연결된 DB가 다른 PC(다른 사람)의 연결이면 이 PC에서는 확인할 수 없다
  if (!connection) return null;
  const [db, baseline] = await Promise.all([api.introspect(connection.id), projectApi.baseline(projectId, connection.id)]);
  return { connection, db, baseline, checkedAt: new Date().toISOString() };
}

/** 지금 ERD와 읽어 둔 DB 구조를 비교한다 */
function compareSnapshot(snap: DesktopSnapshot): import('./api').DbStatus {
  const plan = planPull(useStore.getState().schema, snap.db.schema, { dialect: getDialect(snap.db.dialect), baseline: snap.baseline?.schema });
  return {
    connected: true,
    connection: snap.connection.name,
    database: snap.connection.database,
    checkedAt: snap.checkedAt,
    baselineAt: snap.baseline?.at ?? null,
    ...summarizePlan(plan),
  };
}

/** 프로젝트와 연결된 DB가 ERD와 얼마나 다른지 주기적으로 확인한다 */
export function useDbStatus() {
  const projectId = useStore((s) => s.projectId);
  const dbConnectionId = useStore((s) => s.meta.dbConnectionId);
  const serverDb = useStore((s) => s.me?.serverDb !== false);
  const [status, setStatus] = useState<import('./api').DbStatus | null>(null);
  const [error, setError] = useState('');
  const snapshot = useRef<DesktopSnapshot | null>(null);

  // DB 확인이 겹치지 않게 (창 포커스·3분 주기·대화상자 닫기가 한꺼번에 오면 연결이 여러 개 열린다).
  // 진행 중에 또 요청되면 끝난 뒤 한 번만 더 확인한다.
  const running = useRef(false);
  const again = useRef(false);
  const check = useCallback(async (): Promise<void> => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      await checkOnce();
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        void check();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, dbConnectionId, serverDb]);
  const checkOnce = async () => {
    if (!projectId || !dbConnectionId || (!desktop && !serverDb)) {
      snapshot.current = null;
      setStatus(null);
      return;
    }
    try {
      if (desktop) {
        snapshot.current = await readDesktopSnapshot(projectId, dbConnectionId);
        setStatus(snapshot.current ? compareSnapshot(snapshot.current) : { connected: false });
      } else {
        setStatus(await projectApi.dbStatus(projectId));
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    snapshot.current = null;
    check();
    const timer = setInterval(check, STATUS_INTERVAL);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    statusListeners.add(check);
    // ERD가 바뀌면 (내 편집, AI·MCP, 다른 사람, 제안 승인, 버전 복원 모두) 배지를 다시 계산한다.
    // 설치형 앱은 읽어 둔 DB 구조와 바로 비교하고, 서버 모드는 잠시 모았다가 서버에 묻는다.
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.schema === prev.schema) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (snapshot.current) setStatus(compareSnapshot(snapshot.current));
        else if (!desktop) check();
      }, desktop ? 300 : 1500);
    });
    return () => {
      clearInterval(timer);
      clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      statusListeners.delete(check);
    };
  }, [check]);

  return { status, error };
}

/** 이 화면에서 DB 가져오기·내보내기를 쓸 수 있는지: 설치형 앱이거나, 서버가 DB에 접속하는 로컬 모드 */
export function useDbAvailable(): boolean {
  const serverDb = useStore((s) => s.me?.serverDb !== false);
  return Boolean(desktop) || serverDb;
}
