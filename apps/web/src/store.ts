import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { cloneSchema, emptySchema, newId, type DialectId, type Schema } from '@erd/core';

export type ViewMode = 'physical' | 'logical' | 'both';
export type RelationTool = '1:N' | '1:N-identifying' | '1:1' | 'N:M';
export type Selection = { type: 'table'; id: string } | { type: 'relation'; id: string } | null;

export interface Version {
  id: string;
  name: string;
  createdAt: string;
  source: 'manual' | 'auto';
  schema: Schema;
}

interface State {
  projectName: string;
  dialect: DialectId;
  schema: Schema;
  versions: Version[];
  viewMode: ViewMode;
  selection: Selection;
  relationTool: RelationTool;
  past: Schema[];
  future: Schema[];

  /** 스키마를 바꾼다. 되돌리기 기록에 남는다. */
  edit: (fn: (draft: Schema) => void) => void;
  /** 위치 이동처럼 기록에 남기지 않는 변경 */
  editSilently: (fn: (draft: Schema) => void) => void;
  replaceSchema: (schema: Schema) => void;
  undo: () => void;
  redo: () => void;
  select: (selection: Selection) => void;
  setViewMode: (mode: ViewMode) => void;
  setRelationTool: (tool: RelationTool) => void;
  setDialect: (dialect: DialectId) => void;
  setProjectName: (name: string) => void;
  saveVersion: (name: string, source?: Version['source']) => Version;
  deleteVersion: (id: string) => void;
}

const HISTORY_LIMIT = 100;

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      projectName: '새 프로젝트',
      dialect: 'mysql',
      schema: emptySchema(),
      versions: [],
      viewMode: 'physical',
      selection: null,
      relationTool: '1:N',
      past: [],
      future: [],

      edit(fn) {
        const { schema, past } = get();
        const draft = cloneSchema(schema);
        try {
          fn(draft);
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
          return;
        }
        set({ schema: draft, past: [...past.slice(-HISTORY_LIMIT + 1), schema], future: [] });
      },
      editSilently(fn) {
        const draft = cloneSchema(get().schema);
        fn(draft);
        set({ schema: draft });
      },
      replaceSchema(schema) {
        const { schema: current, past } = get();
        set({ schema, past: [...past.slice(-HISTORY_LIMIT + 1), current], future: [], selection: null });
      },
      undo() {
        const { past, future, schema } = get();
        const prev = past.at(-1);
        if (!prev) return;
        set({ schema: prev, past: past.slice(0, -1), future: [schema, ...future] });
      },
      redo() {
        const { past, future, schema } = get();
        const next = future[0];
        if (!next) return;
        set({ schema: next, past: [...past, schema], future: future.slice(1) });
      },
      select: (selection) => set({ selection }),
      setViewMode: (viewMode) => set({ viewMode }),
      setRelationTool: (relationTool) => set({ relationTool }),
      setDialect: (dialect) => set({ dialect }),
      setProjectName: (projectName) => set({ projectName }),
      saveVersion(name, source = 'manual') {
        const version: Version = { id: newId('ver'), name, createdAt: new Date().toISOString(), source, schema: cloneSchema(get().schema) };
        set({ versions: [version, ...get().versions] });
        return version;
      },
      deleteVersion: (id) => set({ versions: get().versions.filter((v) => v.id !== id) }),
    }),
    {
      name: 'erd-project',
      partialize: (s) => ({ projectName: s.projectName, dialect: s.dialect, schema: s.schema, versions: s.versions, viewMode: s.viewMode, relationTool: s.relationTool }),
    },
  ),
);

export function displayName(item: { name: string; logicalName: string }, mode: ViewMode): string {
  if (mode === 'logical') return item.logicalName || item.name;
  return item.name;
}
