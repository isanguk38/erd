import { getBezierPath, getSmoothStepPath, Position, type ConnectionLineComponentProps } from '@xyflow/react';
import { useStore } from '../store';
import { anchors, box, symbol } from './RelationEdge';
import type { TableNodeType } from './TableNode';

const TOOL_LABEL: Record<string, string> = { '1:N': '1:N', '1:N-identifying': '1:N 식별', '1:1': '1:1', 'N:M': 'N:M (연결 테이블)' };

/**
 * 관계를 끌어 연결하는 동안 보이는 선.
 * - 놓을 테이블 위에 있으면: 놓았을 때 생길 관계선과 같은 경로·기호(까마귀발 등)를 미리 보여 준다.
 * - 아직 빈 곳이면: 커서 쪽 면에서 나가는 부드러운 곡선 + 끝점.
 * 커서 옆에 "부모 → 자식" 안내를 띄운다 (끌기 시작한 테이블이 부모).
 */
// 주제영역의 참조 카드(ghost)는 연결할 수 없어 시작 노드는 항상 테이블이다
export function ConnectionLine({ fromNode, toNode, toX, toY, connectionStatus }: ConnectionLineComponentProps) {
  const tool = useStore((s) => s.relationTool);
  const parentName = (fromNode.data as TableNodeType['data']).table?.name ?? '';
  const target = toNode && toNode.id !== fromNode.id ? toNode : null;

  let path: string;
  let symbols = '';
  if (target) {
    const [p, c] = anchors(fromNode, target);
    [path] = getSmoothStepPath({ sourceX: p.x, sourceY: p.y, sourcePosition: p.position, targetX: c.x, targetY: c.y, targetPosition: c.position, offset: 24, borderRadius: 6 });
    if (tool !== 'N:M') symbols = `${symbol(p, 'one')} ${symbol(c, tool === '1:1' ? 'one' : 'many')}`;
  } else {
    // 커서가 있는 쪽 면(위·아래·왼쪽·오른쪽)에서 나간다
    const from = box(fromNode);
    const dx = (toX - from.cx) / Math.max(from.w, 1);
    const dy = (toY - from.cy) / Math.max(from.h, 1);
    const side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? Position.Right : Position.Left) : dy >= 0 ? Position.Bottom : Position.Top;
    const start = {
      [Position.Right]: { x: from.x + from.w, y: from.cy },
      [Position.Left]: { x: from.x, y: from.cy },
      [Position.Bottom]: { x: from.cx, y: from.y + from.h },
      [Position.Top]: { x: from.cx, y: from.y },
    }[side];
    const opposite = { [Position.Right]: Position.Left, [Position.Left]: Position.Right, [Position.Top]: Position.Bottom, [Position.Bottom]: Position.Top }[side];
    // 아직 놓을 곳이 없으면 부드러운 곡선 (놓을 테이블 위에 가면 실제 관계선 모양으로 바뀐다)
    [path] = getBezierPath({ sourceX: start.x, sourceY: start.y, sourcePosition: side, targetX: toX, targetY: toY, targetPosition: opposite });
  }

  const ok = Boolean(target) && connectionStatus !== 'invalid';
  const childName = (target?.data as TableNodeType['data'] | undefined)?.table.name;
  // 안내 위치: 놓을 테이블이 있으면 그 테이블 머리 위, 없으면 커서 바로 아래 가운데 (선·테이블을 가리지 않게)
  const label = target ? { x: box(target).x, y: box(target).y - 42, center: false } : { x: toX - 160, y: toY + 14, center: true };
  return (
    <g className={`connection-line${ok ? ' connection-line--ok' : ''}`}>
      <path className="connection-line__path" d={path} fill="none" />
      {symbols && <path className="connection-line__symbol" d={symbols} fill="none" />}
      {!target && <circle className="connection-line__dot" cx={toX} cy={toY} r={5} />}
      <foreignObject x={label.x} y={label.y} width={320} height={40} style={{ overflow: 'visible', pointerEvents: 'none' }}>
        <div className="connection-line__label-wrap" style={{ justifyContent: label.center ? 'center' : 'flex-start' }}>
        <div className="connection-line__label">
          <b>{parentName}</b>
          <span className="connection-line__arrow">→</span>
          {childName ? <b>{childName}</b> : <span className="connection-line__hint">자식 테이블에 놓기</span>}
          <span className="connection-line__tool">{TOOL_LABEL[tool] ?? tool}</span>
        </div>
        </div>
      </foreignObject>
    </g>
  );
}
