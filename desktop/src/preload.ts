// 화면(웹)에 DB 연결 기능을 넘겨준다. 화면은 window.erdDesktop이 있으면 앱 안에서 열린 것으로 보고
// DB 가져오기·내보내기를 켠다. 실제 처리는 main 프로세스(이 PC)에서 한다.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('erdDesktop', {
  version: '0.2.3',
  listConnections: () => ipcRenderer.invoke('erd:connections:list'),
  createConnection: (input: unknown) => ipcRenderer.invoke('erd:connections:create', input),
  updateConnection: (id: string, input: unknown) => ipcRenderer.invoke('erd:connections:update', id, input),
  deleteConnection: (id: string) => ipcRenderer.invoke('erd:connections:delete', id),
  testConnection: (input: unknown) => ipcRenderer.invoke('erd:connections:test', input),
  introspect: (id: string, commentAs: string) => ipcRenderer.invoke('erd:db:introspect', id, commentAs),
  execute: (id: string, statements: string[]) => ipcRenderer.invoke('erd:db:execute', id, statements),
  /** 새 버전 설치 파일을 내려받아 실행한다 (0.2.0부터) */
  installUpdate: (url: string) => ipcRenderer.invoke('erd:update:install', url),
  /** 내려받기 진행률(0~100, 모르면 -1). 돌려준 함수를 부르면 그만 듣는다 */
  onUpdateProgress: (callback: (percent: number) => void) => {
    const listener = (_e: IpcRendererEvent, percent: number) => callback(percent);
    ipcRenderer.on('erd:update:progress', listener);
    return () => ipcRenderer.removeListener('erd:update:progress', listener);
  },
});
