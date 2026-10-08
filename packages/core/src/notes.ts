// 캔버스 메모: 포스트잇처럼 ERD 위에 붙이는 설명 상자 (예: "결제는 KCP 기준, 환불은 별도 테이블").
// ERD 구조(스키마)와 따로 문서의 'notes' 맵에 둔다. 그래서 SQL·비교·DB 동기화·버전에는 영향이 없고,
// 실시간으로 같이 보인다. 전체 탭 메모와 주제영역 탭 메모는 따로다 (areaId).

import * as Y from 'yjs';
import { newId } from './model';

export interface Note {
  id: string;
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  /** 메모 색 (비우면 노랑) */
  color?: string;
  /** 붙인 주제영역 탭. 없으면 전체 탭 */
  areaId?: string;
  createdAt?: string;
  author?: string;
}

export const NOTE_SIZE = { width: 220, height: 120 };
export const NOTE_MIN = { width: 120, height: 60 };
/** 메모 색 (배경). 첫 번째가 기본 */
export const NOTE_COLORS = ['#fef3c7', '#dbeafe', '#dcfce7', '#fce7f3', '#ede9fe', '#f1f5f9'];
const MAX_TEXT = 4000;

export function notesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('notes') as Y.Map<Y.Map<unknown>>;
}

/** 메모 목록. 지워진 주제영역에 붙은 메모는 보이지 않는다 (영역을 되돌리면 다시 보인다) */
export function readNotes(doc: Y.Doc): Note[] {
  const areas = doc.getMap('erd').get('areas') as Y.Map<unknown> | undefined;
  const notes: Note[] = [];
  notesMap(doc).forEach((map, id) => {
    const areaId = (map.get('areaId') as string | undefined) || undefined;
    if (areaId && !areas?.has(areaId)) return;
    const note: Note = {
      id,
      text: (map.get('text') as string) ?? '',
      position: (map.get('position') as Note['position']) ?? { x: 0, y: 0 },
      width: (map.get('width') as number) ?? NOTE_SIZE.width,
      height: (map.get('height') as number) ?? NOTE_SIZE.height,
    };
    const color = map.get('color') as string | undefined;
    if (color) note.color = color;
    if (areaId) note.areaId = areaId;
    const createdAt = map.get('createdAt') as string | undefined;
    if (createdAt) note.createdAt = createdAt;
    const author = map.get('author') as string | undefined;
    if (author) note.author = author;
    notes.push(note);
  });
  return notes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
}

/** 이 탭(영역 id, 전체면 null)에 보이는 메모 */
export function notesOf(notes: Note[], areaId: string | null | undefined): Note[] {
  return notes.filter((n) => (n.areaId ?? null) === (areaId ?? null));
}

const round = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });

export function addNote(doc: Y.Doc, input: Partial<Omit<Note, 'id'>> & { position: Note['position'] }): string {
  const id = newId('note');
  const map = new Y.Map<unknown>();
  map.set('text', (input.text ?? '').slice(0, MAX_TEXT));
  map.set('position', round(input.position));
  map.set('width', Math.round(Math.max(NOTE_MIN.width, input.width ?? NOTE_SIZE.width)));
  map.set('height', Math.round(Math.max(NOTE_MIN.height, input.height ?? NOTE_SIZE.height)));
  if (input.color) map.set('color', input.color);
  if (input.areaId) map.set('areaId', input.areaId);
  if (input.author) map.set('author', input.author);
  map.set('createdAt', input.createdAt ?? new Date().toISOString());
  notesMap(doc).set(id, map);
  return id;
}

export function updateNote(doc: Y.Doc, id: string, patch: Partial<Pick<Note, 'text' | 'position' | 'width' | 'height' | 'color'>>): void {
  const map = notesMap(doc).get(id);
  if (!map) throw new Error('메모를 찾을 수 없습니다');
  if (patch.text !== undefined && patch.text !== map.get('text')) map.set('text', patch.text.slice(0, MAX_TEXT));
  if (patch.position) {
    const p = round(patch.position);
    const old = map.get('position') as Note['position'] | undefined;
    if (!old || old.x !== p.x || old.y !== p.y) map.set('position', p);
  }
  if (patch.width !== undefined) map.set('width', Math.round(Math.max(NOTE_MIN.width, patch.width)));
  if (patch.height !== undefined) map.set('height', Math.round(Math.max(NOTE_MIN.height, patch.height)));
  if (patch.color !== undefined) {
    if (patch.color && patch.color !== NOTE_COLORS[0]) map.set('color', patch.color);
    else map.delete('color');
  }
}

export function removeNote(doc: Y.Doc, id: string): void {
  notesMap(doc).delete(id);
}
