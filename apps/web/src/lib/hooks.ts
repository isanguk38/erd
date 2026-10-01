import { useCallback, useEffect, useState } from 'react';
import type { DialectId } from '@erd/core';
import { useStore } from '../store';
import { projectApi, type VersionInfo } from './api';

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
