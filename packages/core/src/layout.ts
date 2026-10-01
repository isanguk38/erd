import ELK from 'elkjs/lib/elk.bundled.js';
import type { Schema } from './model';
import { estimateTableSize } from './placement';

export interface LayoutOptions {
  direction?: 'RIGHT' | 'DOWN';
}

/**
 * 관계를 보고 테이블을 자동 배치한다 (부모 → 자식 방향의 계층형 배치).
 * 테이블 id → 새 위치를 돌려준다.
 */
export async function autoLayout(schema: Schema, options: LayoutOptions = {}): Promise<Map<string, { x: number; y: number }>> {
  const elk = new ELK();
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': options.direction ?? 'RIGHT',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.componentComponent': '80',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.separateConnectedComponents': 'true',
    },
    children: schema.tables.map((t) => ({ id: t.id, ...estimateTableSize(t) })),
    edges: schema.relations
      .filter((r) => r.fromTableId !== r.toTableId)
      .map((r) => ({ id: r.id, sources: [r.toTableId], targets: [r.fromTableId] })),
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of graph.children ?? []) positions.set(child.id, { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) });
  return positions;
}
