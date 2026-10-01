import { useCallback, useEffect, useState } from 'react';
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

/** 설치형 앱: 사용자 PC에서 DB를 읽어 직접 비교한다 (서버는 DB에 접속하지 않음) */
async function desktopStatus(projectId: string, connectionId: string): Promise<import('./api').DbStatus> {
  const connections = await api.listConnections();
  const connection = connections.find((c) => c.id === connectionId);
  // 이 프로젝트에 연결된 DB가 다른 PC(다른 사람)의 연결이면 이 PC에서는 확인할 수 없다
  if (!connection) return { connected: false };
  const [db, baseline] = await Promise.all([api.introspect(connection.id), projectApi.baseline(projectId, connection.id)]);
  const plan = planPull(useStore.getState().schema, db.schema, { dialect: getDialect(db.dialect), baseline: baseline?.schema });
  return {
    connected: true,
    connection: connection.name,
    database: connection.database,
    checkedAt: new Date().toISOString(),
    baselineAt: baseline?.at ?? null,
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

  const check = useCallback(async () => {
    if (!projectId || !dbConnectionId || (!desktop && !serverDb)) {
      setStatus(null);
      return;
    }
    try {
      setStatus(desktop ? await desktopStatus(projectId, dbConnectionId) : await projectApi.dbStatus(projectId));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, dbConnectionId, serverDb]);

  useEffect(() => {
    check();
    const timer = setInterval(check, STATUS_INTERVAL);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    statusListeners.add(check);
    return () => {
      clearInterval(timer);
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
