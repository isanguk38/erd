import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import {
  addComment,
  changedTables,
  cloneSchema,
  deleteComment,
  emptySchema,
  readComments,
  readDictionary,
  readDictCase,
  type DictCase,
  readMeta,
  readNotes,
  addNote as addNoteToDoc,
  updateNote as updateNoteInDoc,
  removeNote as removeNoteFromDoc,
  type Dictionary,
  type Note,
  readSchema,
  replyComment,
  setCommentStatus,
  writeMeta,
  writeSchema,
  type CommentAuthor,
  type CommentKind,
  type CommentThread,
  type DialectId,
  type ProjectMeta,
  type Area,
  type Schema,
} from '@erd/core';
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
/** 댓글 변경 (되돌리기 대상 아님) */
const COMMENT = 'comment';
/** 다른 사람·AI가 바꾼 곳을 강조하는 시간 */
const HIGHLIGHT_MS = 4000;

export type RemoteChange = { added: boolean; columnIds: string[]; at: number };

const COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

interface LocalPrefs {
  viewMode: ViewMode;
  relationTool: RelationTool;
  userName: string;
  userColor: string;
}

interface State extends LocalPrefs {
  projectId: string | null;
  schema: Schema;
  meta: ProjectMeta;
  selection: Selection;
  /** 여러 테이블을 골랐을 때 (Shift 드래그, Ctrl 클릭). 하나만 골랐으면 selection과 같다 */
  selectedTables: string[];
  /** 오른쪽 편집 창이 열려 있는지. 테이블·관계를 더블클릭하거나 새로 만들면 열리고, 빈 곳을 클릭하면 닫힌다 (클릭·끌기만으로는 열리지 않음) */
  inspectorOpen: boolean;
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
  /** Ctrl+F 검색 */
  searchOpen: boolean;
  searchQuery: string;
  /** 검색 결과에서 고른 것 (잠깐 강조) */
  searchFocus: { tableId: string; columnId?: string; at: number } | null;
  /** keepQuery: 창만 닫고 검색어는 남긴다 (결과를 골랐을 때 — 다시 열면 이어서 찾기) */
  setSearchOpen: (open: boolean, keepQuery?: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchFocus: (focus: { tableId: string; columnId?: string } | null) => void;
  /** 테이블·컬럼 댓글 */
  comments: CommentThread[];
  addComment: (input: { tableId: string; columnId?: string; kind: CommentKind; text: string }) => void;
  /** 여러 테이블에 같은 댓글을 한 번에 */
  addComments: (tableIds: string[], kind: CommentKind, text: string) => void;
  /** 설계 검사에서 무시한 항목 (프로젝트에 저장, 함께 쓰는 사람·AI도 같이 본다) */
  setLintIgnored: (ids: string[]) => void;
  replyComment: (threadId: string, text: string) => void;
  setCommentStatus: (threadId: string, status: CommentThread['status']) => void;
  deleteComment: (threadId: string) => void;
  /** 캔버스 메모 (스키마와 따로 저장, Ctrl+Z 대상) */
  notes: Note[];
  /** 메모 추가. 만든 메모 id (편집할 수 없으면 null) */
  addNote: (input: { position: { x: number; y: number }; areaId?: string | null; text?: string; color?: string }) => string | null;
  updateNote: (id: string, patch: Partial<Pick<Note, 'text' | 'position' | 'width' | 'height' | 'color'>>) => void;
  removeNotes: (ids: string[]) => void;
  /** 표준 용어 사전 (없으면 null) */
  dictionary: Dictionary | null;
  /** 물리명 표기 (사전이 없어도 정해 둘 수 있다) */
  dictCase: DictCase;
  /** 사전 고치기 (되돌리기 대상 아님) */
  editDictionary: (fn: (d: Y.Doc) => void) => boolean;
  /** 화면 아래 잠깐 뜨는 안내 (되돌릴 수 있는 작업 등) */
  notice: { text: string; action?: { label: string; run: () => void } } | null;
  showNotice: (notice: State['notice']) => void;
  /** 다른 사람·AI가 방금 바꾼 테이블 (잠깐 강조) */
  remoteChanges: Record<string, RemoteChange>;
  /** 버전 비교 중이면 기준 버전 (편집은 잠긴다) */
  compare: { name: string; createdAt: string; schema: Schema } | null;

  setCompare: (compare: State['compare']) => void;
  /** 지금 보고 있는 주제영역 탭 (null이면 전체). 프로젝트마다 마지막 탭을 기억한다 */
  activeArea: string | null;
  setActiveArea: (areaId: string | null) => void;
  /** 이 테이블이 지금 탭에 없으면 그 테이블이 있는 영역(없으면 전체)으로 바꾼다. 바꿨으면 true */
  revealTable: (tableId: string) => boolean;
  open: (projectId: string) => void;
  close: () => void;
  /** 스키마를 바꾼다. 바뀐 부분만 문서에 기록되어 다른 사람에게 바로 보인다. */
  edit: (fn: (draft: Schema) => void) => void;
  replaceSchema: (schema: Schema) => void;
  undo: () => void;
  redo: () => void;
  /** open: 편집 창도 연다. 이미 열려 있으면 고른 것을 보여 준다 */
  select: (selection: Selection, open?: boolean) => void;
  /** 여러 테이블 고르기. 하나면 그 테이블을 고른 것과 같다 */
  selectTables: (ids: string[]) => void;
  setCursor: (cursor: { x: number; y: number } | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setRelationTool: (tool: RelationTool) => void;
  setUserName: (name: string) => void;
  setDialect: (dialect: DialectId) => void;
  setProjectName: (name: string) => void;
}

function readActiveArea(projectId: string): string | null {
  try {
    return localStorage.getItem(`erd.area.${projectId}`) || null;
  } catch {
    return null;
  }
}

/** 영역이 없을 때 쓰는 빈 목록. 셀렉터가 매번 새 []를 돌려주면 무한히 다시 그린다 */
const NO_AREAS: Area[] = [];
/** 주제영역 목록 (없으면 늘 같은 빈 배열) */
export const selectAreas = (s: { schema: Schema }): Area[] => s.schema.areas ?? NO_AREAS;

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

      // 댓글: 보기 권한·비교 중에는 쓸 수 없다 (서버가 보기 권한의 변경을 받지 않는다)
      const author = (): CommentAuthor => {
        const { me, userName } = get();
        return me?.user ? { id: me.user.id, name: me.user.name } : { name: userName || '익명' };
      };
      const commentEdit = (fn: (d: Y.Doc) => void) => {
        if (!doc || !get().synced || get().role === 'viewer') return;
        const d = doc;
        try {
          d.transact(() => fn(d), COMMENT);
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
          return;
        }
        set({ comments: readComments(d) });
      };

      // 메모: 스키마 편집과 같이 Ctrl+Z로 되돌린다
      const noteEdit = (fn: (d: Y.Doc) => void): boolean => {
        if (!doc || !get().synced || get().compare || get().role === 'viewer') return false;
        const d = doc;
        try {
          d.transact(() => fn(d), LOCAL);
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
          return false;
        }
        set({ notes: readNotes(d) });
        return true;
      };

      const publishPresence = () => {
        const { userName, userColor, selection } = get();
        provider?.awareness.setLocalStateField('user', { name: userName, color: userColor });
        provider?.awareness.setLocalStateField('selection', selection);
      };

      return {
        viewMode: 'physical',
        relationTool: '1:N',
        userName: '',
        userColor: COLORS[Math.floor(Math.random() * COLORS.length)],

        projectId: null,
        schema: emptySchema(),
        meta: emptyMeta,
        selection: null,
        selectedTables: [],
        inspectorOpen: false,
        status: 'connecting',
        synced: false,
        peers: [],
        canUndo: false,
        canRedo: false,
        compare: null,
        activeArea: null,
        me: null,
        comments: [],
        notes: [],
        dictionary: null,
        dictCase: 'asis',
        remoteChanges: {},
        notice: null,
        showNotice: (notice) => set({ notice }),
        searchOpen: false,
        searchQuery: '',
        searchFocus: null,
        setSearchOpen: (searchOpen, keepQuery) => set(searchOpen || keepQuery ? { searchOpen } : { searchOpen, searchQuery: '' }),
        setSearchQuery: (searchQuery) => set({ searchQuery }),
        setSearchFocus: (focus) => set({ searchFocus: focus ? { ...focus, at: Date.now() } : null }),
        role: null,
        openError: '',
        setMe: (me) => {
          set({ me });
          // 로그인 모드에서는 계정 이름을, 로컬 모드에서는 직접 정한 이름을 함께 작업할 때 보여준다
          if (me?.authEnabled && me.user) get().setUserName(me.user.name);
        },

        setCompare: (compare) => set({ compare, selection: null, selectedTables: [], inspectorOpen: false }),

        open(projectId) {
          if (get().projectId === projectId) return;
          get().close();
          doc = new Y.Doc();
          provider = new WebsocketProvider(wsUrl(), projectId, doc);
          undoManager = new Y.UndoManager([doc.getMap('erd'), doc.getMap('notes')], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
          undoManager.on('stack-item-added', refreshUndo);
          undoManager.on('stack-item-popped', refreshUndo);

          // 여러 변경이 한꺼번에 와도 한 번만 다시 읽는다.
          // requestAnimationFrame은 창이 가려지면 멈추므로 타이머를 쓴다 (뒤에 있는 탭도 최신 상태 유지).
          let pending: ReturnType<typeof setTimeout> | null = null;
          let remote = false;
          const um = undoManager;
          doc.on('update', (_update: Uint8Array, origin: unknown) => {
            // 내 편집·내 되돌리기·내 댓글이 아니면 다른 사람(또는 AI·서버)의 변경
            if (origin !== LOCAL && origin !== COMMENT && origin !== um) remote = true;
            if (pending) return;
            pending = setTimeout(() => {
              pending = null;
              if (!doc) return;
              const next = readSchema(doc);
              const patch: Partial<State> = { schema: next, meta: readMeta(doc), comments: readComments(doc) };
              // 메모는 바뀌었을 때만 새 목록 (캔버스를 덜 다시 그리게)
              const notes = readNotes(doc);
              if (JSON.stringify(notes) !== JSON.stringify(get().notes)) patch.notes = notes;
              if (remote && get().synced) {
                const changed = changedTables(get().schema, next);
                if (changed.size) {
                  const now = Date.now();
                  const marks = { ...get().remoteChanges };
                  changed.forEach((c, id) => (marks[id] = { ...c, at: now }));
                  patch.remoteChanges = marks;
                  setTimeout(() => {
                    const left = Object.fromEntries(Object.entries(get().remoteChanges).filter(([, m]) => Date.now() - m.at < HIGHLIGHT_MS));
                    set({ remoteChanges: left });
                  }, HIGHLIGHT_MS + 50);
                }
              }
              remote = false;
              set(patch);
            }, 16);
          });
          provider.on('status', ({ status }: { status: SyncStatus }) => set({ status }));
          provider.on('sync', (synced: boolean) => {
            set({ synced });
            if (synced && doc) set({ schema: readSchema(doc), meta: readMeta(doc), comments: readComments(doc), notes: readNotes(doc), dictionary: readDictionary(doc), dictCase: readDictCase(doc) });
          });
          // 사전은 클 수 있어 사전이 바뀔 때만 다시 읽는다
          const dictDoc = doc;
          doc.getMap('dictionary').observeDeep(() => set({ dictionary: readDictionary(dictDoc), dictCase: readDictCase(dictDoc) }));
          provider.awareness.on('change', () => {
            const me = provider?.awareness.clientID;
            const peers: Peer[] = [];
            provider?.awareness.getStates().forEach((state, clientId) => {
              if (clientId === me || !state.user) return;
              peers.push({ clientId, name: state.user.name || '익명', color: state.user.color, selection: state.selection ?? null, cursor: state.cursor ?? null });
            });
            set({ peers });
          });
          set({ projectId, schema: emptySchema(), meta: emptyMeta, comments: [], notes: [], dictionary: null, dictCase: 'asis', remoteChanges: {}, selection: null, selectedTables: [], inspectorOpen: false, synced: false, status: 'connecting', peers: [], canUndo: false, canRedo: false, role: null, openError: '', activeArea: readActiveArea(projectId) });
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
            if (copy.areas) draft.areas = copy.areas;
          });
          set({ selection: null, selectedTables: [], inspectorOpen: false });
        },

        addComment(input) {
          commentEdit((d) => addComment(d, { ...input, author: author() }));
        },
        addComments(tableIds, kind, text) {
          commentEdit((d) => tableIds.forEach((tableId) => addComment(d, { tableId, kind, text, author: author() })));
        },
        setLintIgnored(ids) {
          // 되돌리기(Ctrl+Z) 대상이 아닌 설정이라 댓글과 같은 방식으로 기록한다
          commentEdit((d) => writeMeta(d, { lintIgnored: [...new Set(ids)] }));
          if (doc) set({ meta: readMeta(doc) });
        },
        replyComment(threadId, text) {
          commentEdit((d) => replyComment(d, threadId, author(), text));
        },
        setCommentStatus(threadId, status) {
          commentEdit((d) => setCommentStatus(d, threadId, status, author()));
        },
        deleteComment(threadId) {
          commentEdit((d) => deleteComment(d, threadId));
        },

        addNote(input) {
          let id: string | null = null;
          const author = get().me?.user?.name || get().userName || undefined;
          noteEdit((d) => {
            id = addNoteToDoc(d, { position: input.position, areaId: input.areaId ?? undefined, text: input.text, color: input.color, author });
          });
          return id;
        },
        updateNote(id, patch) {
          noteEdit((d) => updateNoteInDoc(d, id, patch));
        },
        removeNotes(ids) {
          if (ids.length) noteEdit((d) => ids.forEach((id) => removeNoteFromDoc(d, id)));
        },
        editDictionary(fn) {
          if (!doc || !get().synced || get().role === 'viewer') return false;
          const d = doc;
          try {
            d.transact(() => fn(d), COMMENT);
          } catch (e) {
            alert(e instanceof Error ? e.message : String(e));
            return false;
          }
          set({ dictionary: readDictionary(d), dictCase: readDictCase(d) });
          return true;
        },

        undo() {
          undoManager?.undo();
        },
        redo() {
          undoManager?.redo();
        },

        setActiveArea(areaId) {
          const { projectId } = get();
          set({ activeArea: areaId });
          try {
            if (projectId) localStorage.setItem(`erd.area.${projectId}`, areaId ?? '');
          } catch {
            // 저장이 막혀 있어도 지금 화면에는 적용된다
          }
        },
        revealTable(tableId) {
          const { activeArea, schema } = get();
          const area = activeArea ? schema.areas?.find((a) => a.id === activeArea) : undefined;
          if (!area || area.tableIds.includes(tableId)) return false;
          get().setActiveArea(schema.areas?.find((a) => a.tableIds.includes(tableId))?.id ?? null);
          return true;
        },

        select(selection, open) {
          set({ selection, selectedTables: selection?.type === 'table' ? [selection.id] : [], inspectorOpen: selection ? Boolean(open) || get().inspectorOpen : false });
          provider?.awareness.setLocalStateField('selection', selection);
        },

        selectTables(ids) {
          if (ids.length === 1) return get().select({ type: 'table', id: ids[0] });
          set({ selection: null, selectedTables: ids });
          provider?.awareness.setLocalStateField('selection', null);
        },

        setCursor(cursor) {
          provider?.awareness.setLocalStateField('cursor', cursor);
        },

        setViewMode: (viewMode) => set({ viewMode }),
        setRelationTool: (relationTool) => set({ relationTool }),
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
