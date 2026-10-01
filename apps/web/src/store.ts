import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { cloneSchema, emptySchema, readMeta, readSchema, writeMeta, writeSchema, type DialectId, type ProjectMeta, type Schema } from '@erd/core';
import { authApi, type Me, type Role } from './lib/api';

export type ViewMode = 'physical' | 'logical' | 'both';
export type RelationTool = '1:N' | '1:N-identifying' | '1:1' | 'N:M';
export type Selection = { type: 'table'; id: string } | { type: 'relation'; id: string } | null;
export type SyncStatus = 'connecting' | 'connected' | 'disconnected';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  selection: Selection;
  cursor: { x: number; y: number } | null;
}

/** 이 화면에서 한 변경 (되돌리기 대상) */
const LOCAL = 'local';

const COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

interface LocalPrefs {
  viewMode: ViewMode;
  relationTool: RelationTool;
  connectionId: string | null;
  userName: string;
  userColor: string;
}

interface State extends LocalPrefs {
  projectId: string | null;
  schema: Schema;
  meta: ProjectMeta;
  selection: Selection;
  status: SyncStatus;
  synced: boolean;
  peers: Peer[];
  canUndo: boolean;
  canRedo: boolean;
  /** 로그인 정보 (로컬 모드면 authEnabled=false) */
  me: Me | null;
  /** 지금 프로젝트에서 내 권한. viewer면 편집할 수 없다 */
  role: Role | null;
  /** 프로젝트를 열 수 없을 때 (권한 없음 등) */
  openError: string;
  setMe: (me: Me | null) => void;
  /** 버전 비교 중이면 기준 버전 (편집은 잠긴다) */
  compare: { name: string; createdAt: string; schema: Schema } | null;

  setCompare: (compare: State['compare']) => void;
  open: (projectId: string) => void;
  close: () => void;
  /** 스키마를 바꾼다. 바뀐 부분만 문서에 기록되어 다른 사람에게 바로 보인다. */
  edit: (fn: (draft: Schema) => void) => void;
  replaceSchema: (schema: Schema) => void;
  undo: () => void;
  redo: () => void;
  select: (selection: Selection) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setRelationTool: (tool: RelationTool) => void;
  setConnectionId: (id: string | null) => void;
  setUserName: (name: string) => void;
  setDialect: (dialect: DialectId) => void;
  setProjectName: (name: string) => void;
}

// Yjs 객체는 직렬화하지 않도록 스토어 밖에 둔다
let doc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;
let undoManager: Y.UndoManager | null = null;

const emptyMeta: ProjectMeta = { name: '', dialect: 'mysql' };

function wsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const refreshUndo = () => set({ canUndo: (undoManager?.undoStack.length ?? 0) > 0, canRedo: (undoManager?.redoStack.length ?? 0) > 0 });

      const publishPresence = () => {
        const { userName, userColor, selection } = get();
        provider?.awareness.setLocalStateField('user', { name: userName, color: userColor });
        provider?.awareness.setLocalStateField('selection', selection);
      };

      return {
        viewMode: 'physical',
        relationTool: '1:N',
        connectionId: null,
        userName: '',
        userColor: COLORS[Math.floor(Math.random() * COLORS.length)],

        projectId: null,
        schema: emptySchema(),
        meta: emptyMeta,
        selection: null,
        status: 'connecting',
        synced: false,
        peers: [],
        canUndo: false,
        canRedo: false,
        compare: null,
        me: null,
        role: null,
        openError: '',
        setMe: (me) => {
          set({ me });
          // 로그인 모드에서는 계정 이름을, 로컬 모드에서는 직접 정한 이름을 함께 작업할 때 보여준다
          if (me?.authEnabled && me.user) get().setUserName(me.user.name);
        },

        setCompare: (compare) => set({ compare, selection: null }),

        open(projectId) {
          if (get().projectId === projectId) return;
          get().close();
          doc = new Y.Doc();
          provider = new WebsocketProvider(wsUrl(), projectId, doc);
          undoManager = new Y.UndoManager(doc.getMap('erd'), { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
          undoManager.on('stack-item-added', refreshUndo);
          undoManager.on('stack-item-popped', refreshUndo);

          // 여러 변경이 한꺼번에 와도 한 번만 다시 읽는다.
          // requestAnimationFrame은 창이 가려지면 멈추므로 타이머를 쓴다 (뒤에 있는 탭도 최신 상태 유지).
          let pending: ReturnType<typeof setTimeout> | null = null;
          doc.on('update', () => {
            if (pending) return;
            pending = setTimeout(() => {
              pending = null;
              if (!doc) return;
              set({ schema: readSchema(doc), meta: readMeta(doc) });
            }, 16);
          });
          provider.on('status', ({ status }: { status: SyncStatus }) => set({ status }));
          provider.on('sync', (synced: boolean) => {
            set({ synced });
            if (synced && doc) set({ schema: readSchema(doc), meta: readMeta(doc) });
          });
          provider.awareness.on('change', () => {
            const me = provider?.awareness.clientID;
            const peers: Peer[] = [];
            provider?.awareness.getStates().forEach((state, clientId) => {
              if (clientId === me || !state.user) return;
              peers.push({ clientId, name: state.user.name || '익명', color: state.user.color, selection: state.selection ?? null, cursor: state.cursor ?? null });
            });
            set({ peers });
          });
          set({ projectId, schema: emptySchema(), meta: emptyMeta, selection: null, synced: false, status: 'connecting', peers: [], canUndo: false, canRedo: false, role: null, openError: '' });
          publishPresence();
          authApi
            .project(projectId)
            .then((p) => get().projectId === projectId && set({ role: p.role }))
            .catch((e) => get().projectId === projectId && set({ openError: e instanceof Error ? e.message : String(e) }));
        },

        close() {
          provider?.destroy();
          undoManager?.destroy();
          doc?.destroy();
          provider = null;
          undoManager = null;
          doc = null;
          set({ projectId: null, peers: [], synced: false, compare: null });
        },

        edit(fn) {
          // 서버 문서를 받기 전에 쓰면 최상위 맵이 겹쳐 서버 내용이 사라질 수 있으므로 막는다. 비교 중에는 편집하지 않는다.
          if (!doc || !get().synced || get().compare || get().role === 'viewer') return;
          const draft = cloneSchema(get().schema);
          try {
            fn(draft);
          } catch (e) {
            alert(e instanceof Error ? e.message : String(e));
            return;
          }
          const d = doc;
          d.transact(() => writeSchema(d, draft), LOCAL);
          // 내 화면은 바로 갱신 (다른 사람 화면은 동기화로 갱신)
          set({ schema: readSchema(d) });
        },

        replaceSchema(schema) {
          get().edit((draft) => {
            const copy = cloneSchema(schema);
            draft.tables = copy.tables;
            draft.relations = copy.relations;
          });
          set({ selection: null });
        },

        undo() {
          undoManager?.undo();
        },
        redo() {
          undoManager?.redo();
        },

        select(selection) {
          set({ selection });
          provider?.awareness.setLocalStateField('selection', selection);
        },

        setCursor(cursor) {
          provider?.awareness.setLocalStateField('cursor', cursor);
        },

        setViewMode: (viewMode) => set({ viewMode }),
        setRelationTool: (relationTool) => set({ relationTool }),
        setConnectionId: (connectionId) => set({ connectionId }),
        setUserName(userName) {
          set({ userName });
          publishPresence();
        },
        setDialect(dialect) {
          const d = doc;
          if (!get().synced || get().role === 'viewer') return;
          d?.transact(() => writeMeta(d, { dialect }), LOCAL);
        },
        setProjectName(name) {
          const d = doc;
          if (!get().synced || get().role === 'viewer') return;
          d?.transact(() => writeMeta(d, { name }), LOCAL);
        },
      };
    },
    {
      name: 'erd-prefs',
      partialize: (s): LocalPrefs => ({
        viewMode: s.viewMode,
        relationTool: s.relationTool,
        connectionId: s.connectionId,
        userName: s.userName,
        userColor: s.userColor,
      }),
    },
  ),
);

export function displayName(item: { name: string; logicalName: string }, mode: ViewMode): string {
  if (mode === 'logical') return item.logicalName || item.name;
  return item.name;
}

/** 이전 버전(브라우저에만 저장하던 시절)의 ERD. 서버 프로젝트로 옮길 때 쓴다. */
export function legacyProject(): { name: string; dialect: DialectId; schema: Schema } | null {
  try {
    const raw = localStorage.getItem('erd-project');
    if (!raw) return null;
    const state = JSON.parse(raw).state;
    if (!state?.schema?.tables?.length) return null;
    return { name: state.projectName ?? '가져온 프로젝트', dialect: state.dialect ?? 'mysql', schema: state.schema };
  } catch {
    return null;
  }
}

export function clearLegacyProject(): void {
  try {
    localStorage.removeItem('erd-project');
  } catch {
    /* 무시 */
  }
}
