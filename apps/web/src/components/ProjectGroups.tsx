// 메인 화면의 프로젝트 그룹 (GitLab의 그룹처럼 폴더, 그룹 안에 하위 그룹).
// 내 그룹은 서버의 그룹 목록, 공유받은 프로젝트의 그룹은 그 프로젝트의 그룹 경로로 만든 "보기 전용" 그룹이다
// (공유는 프로젝트 단위라 공유받은 그룹 안에는 받은 프로젝트만 보이고, 만들거나 고칠 수 없다).

import { useState, type CSSProperties } from 'react';
import type { GroupInfo, ProjectInfo } from '../lib/api';
import { ColorPicker } from './ColorPicker';
import { Modal } from './Modal';
import { Icon } from './ui';

/** 편집 화면에서 "프로젝트 목록"으로 돌아갈 때 마지막으로 보던 그룹으로 (이 탭에서만 기억) */
export const LAST_GROUP_KEY = 'erd.lastGroup';
export function projectListHref(): string {
  try {
    const g = sessionStorage.getItem(LAST_GROUP_KEY);
    return g ? `#/g/${g}` : '#/';
  } catch {
    return '#/';
  }
}

export interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  color?: string;
  /** 공유받은 프로젝트의 그룹이면 그 주인 이름 (보기 전용) */
  sharedBy?: string;
}

/** 내 그룹 + 공유받은 프로젝트의 그룹 경로 */
export function buildGroupNodes(groups: GroupInfo[], projects: ProjectInfo[]): Map<string, GroupNode> {
  const nodes = new Map<string, GroupNode>();
  for (const g of groups) nodes.set(g.id, { id: g.id, name: g.name, parentId: g.parentId, color: g.color });
  for (const p of projects) {
    if (!p.groupOwner || !p.groupPath) continue;
    p.groupPath.forEach((g, i) => {
      if (!nodes.has(g.id)) nodes.set(g.id, { id: g.id, name: g.name, parentId: i ? p.groupPath![i - 1]!.id : null, color: g.color, sharedBy: p.groupOwner });
    });
  }
  return nodes;
}

/** 맨 위 → 이 그룹까지 */
export function groupTrail(nodes: Map<string, GroupNode>, id: string | null): GroupNode[] {
  const trail: GroupNode[] = [];
  for (let n = id ? nodes.get(id) : undefined; n && trail.length < 20; n = n.parentId ? nodes.get(n.parentId) : undefined) trail.unshift(n);
  return trail;
}

/** 내 그룹을 트리 순서(들여쓰기 깊이와 함께)로. skip 그룹과 그 하위는 뺀다 (그룹을 자기 안으로 옮기지 않게) */
function ownTree(groups: GroupInfo[], skip?: string): { group: GroupInfo; depth: number }[] {
  const out: { group: GroupInfo; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const g of groups.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, 'ko'))) {
      if (g.id === skip) continue;
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 그룹 카드·경로에 그룹 색 (없으면 CSS 기본색) */
export const groupColorStyle = (color?: string) => (color ? ({ '--gc': color } as CSSProperties) : undefined);

/** 그룹 색 고르기: 고른 색을 미리 보고 저장 (직접 고르기로 끌 때마다 저장하지 않게) */
export function GroupColorDialog({ name, color, onSave, onClose }: { name: string; color?: string; onSave: (color: string | null) => Promise<void>; onClose: () => void }) {
  const [picked, setPicked] = useState<string | undefined>(color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title="그룹 색"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button
            className="btn btn-primary"
            disabled={busy || picked === color}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(picked ?? null);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          >
            저장
          </button>
        </>
      }
    >
      <div className="group-color">
        <div className="group-color__preview group-card" style={groupColorStyle(picked)}>
          <span className="group-card__icon" aria-hidden="true"><Icon name="folder" size={20} /></span>
          <b>{name}</b>
        </div>
        <ColorPicker inline allowDefault value={picked} onChange={(c) => setPicked(c?.toLowerCase())} />
        <p className="muted small">"기본"은 주황색 폴더입니다. 이 프로젝트를 공유받은 사람에게도 같은 색으로 보입니다.</p>
      </div>
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}

/** 옮길 곳 고르기 (프로젝트·그룹 공통) */
export function MoveDialog({ title, groups, current, skip, onMove, onClose }: {
  title: string;
  groups: GroupInfo[];
  /** 지금 있는 그룹 (null = 맨 위) */
  current: string | null;
  /** 그룹을 옮길 때: 그 그룹 (자기와 하위로는 못 옮김) */
  skip?: string;
  onMove: (groupId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(current);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const options: { id: string | null; name: string; depth: number; color?: string }[] = [
    { id: null, name: '맨 위 (그룹 없음)', depth: 0 },
    ...ownTree(groups, skip).map(({ group, depth }) => ({ id: group.id, name: group.name, depth: depth + 1, color: group.color })),
  ];
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button
            className="btn btn-primary"
            disabled={busy || picked === current}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onMove(picked);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            }}
          >
            여기로 옮기기
          </button>
        </>
      }
    >
      <ul className="group-pick" role="listbox" aria-label="옮길 그룹">
        {options.map((o) => (
          <li key={o.id ?? 'root'}>
            <button
              role="option"
              aria-selected={picked === o.id}
              className={picked === o.id ? 'active' : ''}
              style={{ paddingLeft: 10 + o.depth * 18 }}
              onClick={() => setPicked(o.id)}
            >
              <span className="group-pick__icon" style={groupColorStyle(o.color)}><Icon name={o.id ? 'folder' : 'layout'} size={15} /></span>
              <span>{o.name}</span>
              {o.id === current && <span className="muted small">지금 위치</span>}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="error-box">{error}</div>}
    </Modal>
  );
}
