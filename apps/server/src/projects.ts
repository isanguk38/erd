// 프로젝트 저장소.
// - ERD 본문은 Yjs 문서로 메모리에 두고 바뀔 때마다(1초 모아서) 파일에 저장한다.
// - 버전과 AI 제안은 JSON 파일로 저장한다.
// 화면(WebSocket), REST API, MCP가 모두 같은 Y.Doc을 바꾸므로 서로의 변경이 실시간으로 보인다.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  applyChanges,
  diffSchemas,
  emptySchema,
  getDialect,
  metaMap,
  readMeta,
  readSchema,
  writeMeta,
  writeSchema,
  type Change,
  type DialectId,
  type ProjectMeta,
  type Schema,
} from '@erd/core';

export interface ProjectInfo {
  id: string;
  name: string;
  dialect: string;
  tableCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  id: string;
  name: string;
  createdAt: string;
  source: 'manual' | 'auto' | 'db' | 'ai';
  schema: Schema;
}

export interface Proposal {
  id: string;
  title: string;
  source: 'ai' | 'api';
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
  updatedAt: string;
  /** 제안을 만들 때의 스키마 */
  base: Schema;
  /** 제안한 결과 스키마 */
  target: Schema;
  messages: string[];
}

export interface LoadedProject {
  doc: Y.Doc;
  awareness: Awareness;
}

/** 변경을 일으킨 쪽. 화면은 이것으로 "AI가 바꿈" 등을 구분한다. */
export type Origin = 'user' | 'ai' | 'api' | 'db' | 'proposal' | 'restore';

const SAVE_DELAY = 1000;

export class ProjectStore {
  private readonly dir: string;
  private readonly loaded = new Map<string, LoadedProject>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'projects');
    mkdirSync(this.dir, { recursive: true });
  }

  private path(id: string, file: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Object.assign(new Error('잘못된 프로젝트 id'), { statusCode: 400 });
    return join(this.dir, id, file);
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }

  private readJson<T>(path: string, fallback: T): T {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  }

  exists(id: string): boolean {
    try {
      return existsSync(this.path(id, 'doc.ydoc'));
    } catch {
      return false;
    }
  }

  private requireProject(id: string): void {
    if (!this.exists(id)) throw Object.assign(new Error('프로젝트를 찾을 수 없습니다'), { statusCode: 404 });
  }

  /** 문서를 메모리에 올린다 (이미 있으면 그대로) */
  load(id: string): LoadedProject {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    this.requireProject(id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, readFileSync(this.path(id, 'doc.ydoc')));
    doc.on('update', () => this.scheduleSave(id));
    const project = { doc, awareness: new Awareness(doc) };
    project.awareness.setLocalState(null); // 서버 자신은 참가자로 보이지 않게
    this.loaded.set(id, project);
    return project;
  }

  private scheduleSave(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => this.save(id), SAVE_DELAY));
  }

  save(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const project = this.loaded.get(id);
    if (!project) return;
    const tmp = this.path(id, 'doc.ydoc.tmp');
    writeFileSync(tmp, Y.encodeStateAsUpdate(project.doc));
    renameSync(tmp, this.path(id, 'doc.ydoc'));
    const info = this.readJson<ProjectInfo>(this.path(id, 'info.json'), {} as ProjectInfo);
    const meta = readMeta(project.doc);
    this.writeJson(this.path(id, 'info.json'), {
      ...info,
      name: meta.name,
      dialect: meta.dialect,
      tableCount: readSchema(project.doc).tables.length,
      updatedAt: new Date().toISOString(),
    });
  }

  /** 서버 종료 전 저장 */
  flush(): void {
    for (const id of this.loaded.keys()) this.save(id);
  }

  list(): ProjectInfo[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((id) => this.exists(id))
      .map((id) => this.readJson<ProjectInfo>(this.path(id, 'info.json'), { id } as ProjectInfo))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  create(name: string, dialect: DialectId, schema: Schema = emptySchema()): ProjectInfo {
    const id = randomUUID();
    mkdirSync(join(this.dir, id), { recursive: true });
    const doc = new Y.Doc();
    doc.transact(() => {
      writeMeta(doc, { name, dialect, aiMode: 'apply', aiAllowDbExecute: false });
      writeSchema(doc, schema);
    });
    writeFileSync(this.path(id, 'doc.ydoc'), Y.encodeStateAsUpdate(doc));
    const now = new Date().toISOString();
    const info: ProjectInfo = { id, name, dialect, tableCount: schema.tables.length, createdAt: now, updatedAt: now };
    this.writeJson(this.path(id, 'info.json'), info);
    return info;
  }

  remove(id: string): void {
    this.requireProject(id);
    const project = this.loaded.get(id);
    project?.doc.destroy();
    this.loaded.delete(id);
    clearTimeout(this.timers.get(id));
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  // ── 읽기/쓰기 ─────────────────────────────

  get(id: string): { id: string; meta: ProjectMeta; schema: Schema } {
    const { doc } = this.load(id);
    return { id, meta: readMeta(doc), schema: readSchema(doc) };
  }

  schema(id: string): Schema {
    return readSchema(this.load(id).doc);
  }

  meta(id: string): ProjectMeta {
    return readMeta(this.load(id).doc);
  }

  dialect(id: string): DialectId {
    return this.meta(id).dialect as DialectId;
  }

  /** 스키마를 바꾼다. 바뀐 필드만 문서에 반영되어 접속한 화면에 바로 보인다. */
  setSchema(id: string, schema: Schema, origin: Origin): void {
    const { doc } = this.load(id);
    doc.transact(() => writeSchema(doc, schema), origin);
  }

  setMeta(id: string, patch: Partial<ProjectMeta>, origin: Origin = 'api'): ProjectMeta {
    const { doc } = this.load(id);
    doc.transact(() => writeMeta(doc, patch), origin);
    return readMeta(doc);
  }

  // ── 버전 ─────────────────────────────

  versions(id: string): Version[] {
    this.requireProject(id);
    return this.readJson<Version[]>(this.path(id, 'versions.json'), []);
  }

  version(id: string, versionId: string): Version {
    const v = this.versions(id).find((x) => x.id === versionId);
    if (!v) throw Object.assign(new Error('버전을 찾을 수 없습니다'), { statusCode: 404 });
    return v;
  }

  saveVersion(id: string, name: string, source: Version['source'], schema = this.schema(id)): Version {
    const version: Version = { id: randomUUID(), name, createdAt: new Date().toISOString(), source, schema };
    this.writeJson(this.path(id, 'versions.json'), [version, ...this.versions(id)].slice(0, 300));
    return version;
  }

  deleteVersion(id: string, versionId: string): void {
    this.writeJson(this.path(id, 'versions.json'), this.versions(id).filter((v) => v.id !== versionId));
  }

  // ── 제안 (AI 제안 모드) ─────────────────────────────

  proposals(id: string): Proposal[] {
    this.requireProject(id);
    return this.readJson<Proposal[]>(this.path(id, 'proposals.json'), []);
  }

  proposal(id: string, proposalId: string): Proposal {
    const p = this.proposals(id).find((x) => x.id === proposalId);
    if (!p) throw Object.assign(new Error('제안을 찾을 수 없습니다'), { statusCode: 404 });
    return p;
  }

  private saveProposals(id: string, list: Proposal[]): void {
    this.writeJson(this.path(id, 'proposals.json'), list.slice(0, 100));
  }

  /**
   * 열려 있는(대기 중인) 같은 출처의 제안에 이어 붙이거나 새로 만든다.
   * AI가 여러 번 나눠 고쳐도 하나의 제안으로 모여 한 번에 검토할 수 있다.
   */
  upsertProposal(id: string, source: Proposal['source'], title: string, update: (target: Schema) => { schema: Schema; messages: string[] }): Proposal {
    const list = this.proposals(id);
    const now = new Date().toISOString();
    let proposal = list.find((p) => p.status === 'pending' && p.source === source);
    if (!proposal) {
      const base = this.schema(id);
      proposal = { id: randomUUID(), title, source, status: 'pending', createdAt: now, updatedAt: now, base, target: base, messages: [] };
      list.unshift(proposal);
    }
    const { schema, messages } = update(proposal.target);
    proposal.target = schema;
    proposal.messages.push(...messages);
    proposal.updatedAt = now;
    this.saveProposals(id, list);
    this.notifyProposals(id);
    return proposal;
  }

  proposalChanges(id: string, proposal: Proposal): Change[] {
    return diffSchemas(proposal.base, proposal.target, getDialect(this.dialect(id))).changes;
  }

  /** 제안 중 고른 변경만 지금 ERD에 반영한다 (그 사이 다른 사람이 고친 부분은 유지). */
  applyProposal(id: string, proposalId: string, selected?: string[]): Change[] {
    const list = this.proposals(id);
    const proposal = list.find((p) => p.id === proposalId);
    if (!proposal) throw Object.assign(new Error('제안을 찾을 수 없습니다'), { statusCode: 404 });
    if (proposal.status !== 'pending') throw Object.assign(new Error('이미 처리한 제안입니다'), { statusCode: 409 });
    const diff = diffSchemas(proposal.base, proposal.target, getDialect(this.dialect(id)));
    const chosen = selected ? new Set(selected) : undefined;
    this.saveVersion(id, `제안 반영 전 · ${proposal.title}`, 'auto');
    this.setSchema(id, applyChanges(this.schema(id), diff, chosen), 'proposal');
    proposal.status = 'applied';
    proposal.updatedAt = new Date().toISOString();
    this.saveProposals(id, list);
    this.notifyProposals(id);
    return diff.changes.filter((c) => !chosen || chosen.has(c.id));
  }

  rejectProposal(id: string, proposalId: string): void {
    const list = this.proposals(id);
    const proposal = list.find((p) => p.id === proposalId);
    if (!proposal) throw Object.assign(new Error('제안을 찾을 수 없습니다'), { statusCode: 404 });
    proposal.status = 'rejected';
    proposal.updatedAt = new Date().toISOString();
    this.saveProposals(id, list);
    this.notifyProposals(id);
  }

  /** 대기 중인 제안 수를 문서 메타에 올려 화면이 바로 알 수 있게 한다 */
  private notifyProposals(id: string): void {
    const pending = this.proposals(id).filter((p) => p.status === 'pending').length;
    const { doc } = this.load(id);
    doc.transact(() => metaMapSet(doc, 'pendingProposals', pending), 'api');
  }
}

function metaMapSet(doc: Y.Doc, key: string, value: unknown) {
  const meta = metaMap(doc);
  if (meta.get(key) !== value) meta.set(key, value);
}

