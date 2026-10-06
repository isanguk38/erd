import { BaseEdge, getSmoothStepPath, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { Cardinality } from '@erd/core';

export type RelationEdgeData = { cardinality: Cardinality; highlight?: 'added' | 'changed' | 'removed' };
export type RelationEdgeType = Edge<RelationEdgeData, 'relation'>;

export interface Anchor {
  x: number;
  y: number;
  position: Position;
}

export function box(node: InternalNode) {
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

/** 두 테이블의 상대 위치를 보고 선이 나갈 면을 고른다. */
export function anchors(a: InternalNode, b: InternalNode): [Anchor, Anchor] {
  const A = box(a);
  const B = box(b);
  if (a.id === b.id) {
    return [
      { x: A.x + A.w, y: A.y + 20, position: Position.Right },
      { x: A.x + A.w, y: A.y + A.h - 20, position: Position.Right },
    ];
  }
  const horizontalGap = Math.abs(B.cx - A.cx) - (A.w + B.w) / 2;
  if (horizontalGap > -40 || Math.abs(B.cy - A.cy) < (A.h + B.h) / 2) {
    return B.cx >= A.cx
      ? [{ x: A.x + A.w, y: A.cy, position: Position.Right }, { x: B.x, y: B.cy, position: Position.Left }]
      : [{ x: A.x, y: A.cy, position: Position.Left }, { x: B.x + B.w, y: B.cy, position: Position.Right }];
  }
  return B.cy >= A.cy
    ? [{ x: A.cx, y: A.y + A.h, position: Position.Bottom }, { x: B.cx, y: B.y, position: Position.Top }]
    : [{ x: A.cx, y: A.y, position: Position.Top }, { x: B.cx, y: B.y + B.h, position: Position.Bottom }];
}

const DIR: Record<Position, [number, number]> = {
  [Position.Left]: [-1, 0],
  [Position.Right]: [1, 0],
  [Position.Top]: [0, -1],
  [Position.Bottom]: [0, 1],
};

/** 면에서 바깥쪽으로 d만큼, 수직으로 p만큼 떨어진 점 */
function at(anchor: Anchor, d: number, p: number): string {
  const [dx, dy] = DIR[anchor.position];
  return `${anchor.x + dx * d - dy * p},${anchor.y + dy * d + dx * p}`;
}

/** 기호: 세로줄 두 개 = "반드시 하나", 까마귀발 + 세로줄 = "하나 이상" */
export function symbol(anchor: Anchor, kind: 'one' | 'many'): string {
  const bar = (d: number) => `M${at(anchor, d, -7)} L${at(anchor, d, 7)}`;
  if (kind === 'one') return `${bar(9)} ${bar(15)}`;
  return `M${at(anchor, 14, 0)} L${at(anchor, 0, -8)} M${at(anchor, 14, 0)} L${at(anchor, 0, 0)} M${at(anchor, 14, 0)} L${at(anchor, 0, 8)} ${bar(18)}`;
}

export function RelationEdge({ id, source, target, data, selected }: EdgeProps<RelationEdgeType>) {
  const parent = useInternalNode(source);
  const child = useInternalNode(target);
  if (!parent || !child) return null;

  const [p, c] = anchors(parent, child);
  const [path] = getSmoothStepPath({
    sourceX: p.x,
    sourceY: p.y,
    sourcePosition: p.position,
    targetX: c.x,
    targetY: c.y,
    targetPosition: c.position,
    offset: 24,
    borderRadius: 6,
  });
  const className = `relation-edge${selected ? ' selected' : ''}${data?.highlight ? ` hl-${data.highlight}` : ''}`;
  const childKind = data?.cardinality === '1:1' ? 'one' : 'many';

  return (
    <g className={className}>
      <BaseEdge id={id} path={path} interactionWidth={16} />
      <path className="relation-edge__symbol" d={`${symbol(p, 'one')} ${symbol(c, childKind)}`} />
    </g>
  );
}
