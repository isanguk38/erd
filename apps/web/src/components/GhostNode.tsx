import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { ViewMode } from '../store';
import { Icon } from './ui';

/** 주제영역 탭에서 영역 밖 테이블을 가리키는 흐린 참조 카드. 누르면 그 테이블이 있는 영역으로 간다 */
export type GhostNodeData = {
  name: string;
  logicalName: string;
  areaNames: string[];
  viewMode: ViewMode;
};
export type GhostNodeType = Node<GhostNodeData, 'ghost'>;

function GhostNodeView({ data }: NodeProps<GhostNodeType>) {
  const title = data.viewMode === 'logical' ? data.logicalName || data.name : data.name;
  const where = data.areaNames.length ? `${data.areaNames.join(' · ')} 영역` : '어느 영역에도 없음';
  return (
    <div className="ghost-node" title={`${data.name}${data.logicalName ? ` (${data.logicalName})` : ''} — ${where}. 누르면 ${data.areaNames.length ? '그 영역' : '전체'}으로 갑니다`}>
      <div className="ghost-node__title">
        <Icon name="external" size={12} />
        <span>{title}</span>
      </div>
      <div className="ghost-node__where">{where} · 누르면 이동</div>
      {/* 관계선이 붙을 자리 (연결은 만들 수 없음) */}
      <Handle type="source" position={Position.Right} className="ghost-node__handle" isConnectable={false} />
      <Handle type="target" position={Position.Left} className="ghost-node__handle" isConnectable={false} />
    </div>
  );
}

export const GhostNode = memo(GhostNodeView);
