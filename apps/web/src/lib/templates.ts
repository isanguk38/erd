import { create } from 'zustand';
import { addTable, applyTemplate, type ColumnTemplate, type Schema, type Table, type TemplateSettings } from '@erd/core';
import { templateApi } from './api';

// 내 컬럼 템플릿 (계정별, 서버에 저장). 처음 필요할 때 한 번 불러온다.

interface TemplateState extends TemplateSettings {
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  save: (settings: TemplateSettings) => Promise<void>;
}

export const useTemplates = create<TemplateState>((set, get) => ({
  templates: [],
  defaultTemplateId: null,
  loaded: false,
  error: '',
  async load() {
    if (get().loaded) return;
    try {
      const s = await templateApi.get();
      set({ ...s, loaded: true, error: '' });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  async save(settings) {
    const saved = await templateApi.save(settings);
    set({ ...saved, loaded: true, error: '' });
  },
}));

export function defaultTemplate(): ColumnTemplate | null {
  const { templates, defaultTemplateId } = useTemplates.getState();
  return templates.find((t) => t.id === defaultTemplateId) ?? null;
}

/** 새 테이블을 만든다. 템플릿을 고르지 않으면 "새 테이블 기본 템플릿"을 넣는다 (없으면 빈 테이블) */
export function addTableWithTemplate(draft: Schema, partial: Partial<Table>, template: ColumnTemplate | null | undefined = defaultTemplate()): Table {
  const table = addTable(draft, partial);
  if (template) applyTemplate(draft, table.id, template);
  return table;
}
