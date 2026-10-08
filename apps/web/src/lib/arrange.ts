import type { Node } from '@xyflow/react';
import { areaSchema, setAreaPosition } from '@erd/core';
import { useStore } from '../store';
import { loadModule } from './appVersion';

/** 화면에 그려진 테이블의 실제 크기 (지금 보기 방식 그대로 — 논리명·긴 인덱스까지 반영) */
export function measuredSizes(nodes: Node[]): Map<string, { width: number; height: number }> {
  const sizes = new Map<string, { width: number; height: number }>();
  for (const n of nodes) {
    if (n.type !== 'table' || !n.measured?.width || !n.measured?.height) continue;
    sizes.set(n.id, { width: Math.ceil(n.measured.width), height: Math.ceil(n.measured.height) });
  }
  return sizes;
}

/**
 * 자동 정렬. 화면에서 잰 크기로 배치해 테이블끼리 겹치지 않게 한다 (잴 수 없는 테이블만 어림값).
 * 주제영역 탭이면 그 영역 테이블만 정렬해 영역 위치로 저장한다 (전체 배치는 그대로).
 */
export async function arrangeTables(nodes: Node[]): Promise<void> {
  const { autoLayout } = await loadModule(() => import('@erd/core/layout'));
  const { schema, activeArea, edit } = useStore.getState();
  const area = activeArea ? schema.areas?.find((a) => a.id === activeArea) : undefined;
  const positions = await autoLayout(area ? areaSchema(schema, area.id).schema : schema, { sizes: measuredSizes(nodes) });
  edit((d) => {
    if (area && d.areas?.some((a) => a.id === area.id)) {
      for (const [id, p] of positions) setAreaPosition(d, area.id, id, p);
      return;
    }
    for (const t of d.tables) t.position = positions.get(t.id) ?? t.position;
  });
}
