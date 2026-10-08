// 설치형 앱(Electron)이 화면에 넣어 주는 DB 연결 기능.
// 앱 안에서 열리면 window.erdDesktop이 있고, DB 가져오기·내보내기를 사용자 PC에서 직접 처리한다.
// 일반 웹 브라우저에서는 없다.

import type { SafetyCheck, SafetyResult } from '@erd/core';
import type { Connection, ConnectionInput, ExecuteResult, IntrospectResult } from './api';

export interface DesktopBridge {
  version: string;
  listConnections(): Promise<Connection[]>;
  createConnection(input: ConnectionInput): Promise<Connection>;
  updateConnection(id: string, input: ConnectionInput): Promise<Connection>;
  deleteConnection(id: string): Promise<{ ok: true }>;
  testConnection(input: ConnectionInput & { id?: string }): Promise<{ serverVersion: string }>;
  introspect(id: string, commentAs: 'logicalName' | 'comment'): Promise<IntrospectResult>;
  execute(id: string, statements: string[]): Promise<ExecuteResult>;
  /** DB 반영 전 안전 검사 (0.2.5부터. 이전 앱에는 없다) */
  check?(id: string, checks: SafetyCheck[]): Promise<SafetyResult[]>;
  /** 새 버전 설치 파일을 내려받아 실행 (0.2.0부터. 0.1.x에는 없다) */
  installUpdate?(url: string): Promise<{ ok: true }>;
  onUpdateProgress?(callback: (percent: number) => void): () => void;
}

export const desktop: DesktopBridge | null = (globalThis as { erdDesktop?: DesktopBridge }).erdDesktop ?? null;

/** 설치형 앱 내려받기 */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/isanguk38/erd/releases/latest';

/** 앱이 보낸 오류는 "Error invoking remote method 'x': Error: 메시지" 형태라 메시지만 남긴다 */
export async function viaDesktop<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}
