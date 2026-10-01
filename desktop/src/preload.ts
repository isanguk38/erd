// 화면(웹)에 DB 연결 기능을 넘겨준다. 화면은 window.erdDesktop이 있으면 앱 안에서 열린 것으로 보고
// DB 가져오기·내보내기를 켠다. 실제 처리는 main 프로세스(이 PC)에서 한다.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('erdDesktop', {
  version: '0.1.0',
  listConnections: () => ipcRenderer.invoke('erd:connections:list'),
  createConnection: (input: unknown) => ipcRenderer.invoke('erd:connections:create', input),
  updateConnection: (id: string, input: unknown) => ipcRenderer.invoke('erd:connections:update', id, input),
  deleteConnection: (id: string) => ipcRenderer.invoke('erd:connections:delete', id),
  testConnection: (input: unknown) => ipcRenderer.invoke('erd:connections:test', input),
  introspect: (id: string, commentAs: string) => ipcRenderer.invoke('erd:db:introspect', id, commentAs),
  execute: (id: string, statements: string[]) => ipcRenderer.invoke('erd:db:execute', id, statements),
});
