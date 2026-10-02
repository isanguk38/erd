// 컬럼 템플릿: 사람마다 쓰는 공통 컬럼 규격(id, created_at, updated_at 등)을 저장해 두고 테이블에 넣는다.

import { createColumn, type Column, type Schema } from './model';

export interface TemplateColumn {
  name: string;
  logicalName: string;
  type: string;
  length: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
  comment: string;
}

export interface ColumnTemplate {
  id: string;
  name: string;
  /** 테이블 맨 앞에 넣을 컬럼 (예: id) */
  top: TemplateColumn[];
  /** 테이블 맨 뒤에 넣을 컬럼 (예: created_at, updated_at) */
  bottom: TemplateColumn[];
}

/** 사용자별 템플릿 설정 */
export interface TemplateSettings {
  templates: ColumnTemplate[];
  /** 새 테이블을 만들 때 자동으로 넣을 템플릿 */
  defaultTemplateId: string | null;
}

export interface ApplyTemplateResult {
  added: string[];
  /** 이미 같은 이름이 있거나, 기본키가 이미 있어 넣지 않은 컬럼 */
  skipped: string[];
}

const col = (c: Partial<TemplateColumn> & Pick<TemplateColumn, 'name' | 'type'>): TemplateColumn => ({
  logicalName: '',
  length: '',
  nullable: true,
  primaryKey: false,
  autoIncrement: false,
  defaultValue: null,
  comment: '',
  ...c,
});

/** 처음 쓸 때 고를 수 있는 예시 템플릿 */
export function sampleTemplates(): ColumnTemplate[] {
  return [
    {
      id: 'sample_snake',
      name: '기본 (snake_case)',
      top: [col({ name: 'id', logicalName: '번호', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true })],
      bottom: [
        col({ name: 'created_at', logicalName: '생성일시', type: 'DATETIME', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }),
        col({ name: 'updated_at', logicalName: '수정일시', type: 'DATETIME', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }),
      ],
    },
    {
      id: 'sample_camel',
      name: '기본 (camelCase)',
      top: [col({ name: 'id', logicalName: '번호', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true })],
      bottom: [
        col({ name: 'createdAt', logicalName: '생성일시', type: 'TIMESTAMP', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }),
        col({ name: 'updatedAt', logicalName: '수정일시', type: 'TIMESTAMP', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' }),
      ],
    },
    {
      id: 'sample_audit',
      name: '감사 컬럼 (작성자·수정자·삭제)',
      top: [],
      bottom: [
        col({ name: 'created_by', logicalName: '작성자', type: 'BIGINT' }),
        col({ name: 'updated_by', logicalName: '수정자', type: 'BIGINT' }),
        col({ name: 'deleted_yn', logicalName: '삭제여부', type: 'CHAR', length: '1', nullable: false, defaultValue: "'N'" }),
      ],
    },
  ];
}

function toColumn(c: TemplateColumn): Column {
  return createColumn({
    name: c.name,
    logicalName: c.logicalName,
    type: c.type.toUpperCase(),
    length: c.length,
    nullable: c.primaryKey ? false : c.nullable,
    primaryKey: c.primaryKey,
    autoIncrement: c.autoIncrement,
    defaultValue: c.defaultValue === '' ? null : c.defaultValue,
    comment: c.comment,
  });
}

/**
 * 템플릿 컬럼을 테이블에 넣는다. 같은 이름(대소문자 무시)의 컬럼이 있으면 건너뛰고,
 * 테이블에 기본키가 이미 있으면 템플릿의 기본키 컬럼은 넣지 않는다 (기본키가 둘이 되지 않게).
 */
export function applyTemplate(schema: Schema, tableId: string, template: ColumnTemplate): ApplyTemplateResult {
  const table = schema.tables.find((t) => t.id === tableId);
  if (!table) throw new Error(`테이블을 찾을 수 없습니다: ${tableId}`);
  const result: ApplyTemplateResult = { added: [], skipped: [] };
  const has = (name: string) => table.columns.some((c) => c.name.toLowerCase() === name.toLowerCase());
  const hadPk = table.columns.some((c) => c.primaryKey);
  const accept = (c: TemplateColumn) => {
    if (!c.name.trim() || has(c.name) || (c.primaryKey && hadPk)) {
      result.skipped.push(c.name);
      return null;
    }
    result.added.push(c.name);
    return toColumn(c);
  };
  const top = template.top.map(accept).filter((c): c is Column => c !== null);
  // 맨 앞 컬럼은 템플릿 순서대로 맨 앞에, 맨 뒤 컬럼은 맨 뒤에
  table.columns.unshift(...top);
  for (const c of template.bottom) {
    const column = accept(c);
    if (column) table.columns.push(column);
  }
  return result;
}

/** 저장 전에 모양을 검사하고 정리한다 (서버·화면 공용) */
export function sanitizeTemplateSettings(input: unknown): TemplateSettings {
  const v = (input ?? {}) as Partial<TemplateSettings>;
  const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.slice(0, max) : '');
  const column = (c: Partial<TemplateColumn>): TemplateColumn => ({
    name: str(c?.name, 128).trim(),
    logicalName: str(c?.logicalName),
    type: str(c?.type, 64).trim() || 'VARCHAR',
    length: str(c?.length, 32),
    nullable: c?.nullable !== false,
    primaryKey: Boolean(c?.primaryKey),
    autoIncrement: Boolean(c?.autoIncrement),
    defaultValue: typeof c?.defaultValue === 'string' && c.defaultValue !== '' ? c.defaultValue.slice(0, 200) : null,
    comment: str(c?.comment, 500),
  });
  const templates = (Array.isArray(v.templates) ? v.templates : []).slice(0, 50).map((t) => ({
    id: str(t?.id, 64) || `tpl_${Math.random().toString(36).slice(2, 10)}`,
    name: str(t?.name, 100).trim() || '이름 없는 템플릿',
    top: (Array.isArray(t?.top) ? t.top : []).slice(0, 50).map(column).filter((c) => c.name),
    bottom: (Array.isArray(t?.bottom) ? t.bottom : []).slice(0, 50).map(column).filter((c) => c.name),
  }));
  const defaultTemplateId = typeof v.defaultTemplateId === 'string' && templates.some((t) => t.id === v.defaultTemplateId) ? v.defaultTemplateId : null;
  return { templates, defaultTemplateId };
}
