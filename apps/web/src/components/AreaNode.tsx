import { memo, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { AREA_COLORS, assignAreas, removeArea, updateArea, type Area } from '@erd/core';
import { useStore } from '../store';
import { measuredSizeOf } from '../lib/sizes';

export type AreaNodeData = { area: Area; tableNames: string[] };
export type AreaNodeType = Node<AreaNodeData, 'area'>;

/** 영역: 관련 테이블을 묶는 색깔 상자. 상자를 끌면 안의 테이블도 함께 움직인다. */
function AreaNodeView({ data, selected }: NodeProps<AreaNodeType>) {
  const { area, tableNames } = data;
  const readOnly = useStore((s) => s.role === 'viewer' || Boolean(s.compare));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const edit = (fn: Parameters<ReturnType<typeof useStore.getState>['edit']>[0]) => useStore.getState().edit(fn);

  const commitName = () => {
    if (renaming !== null && renaming.trim() && renaming !== area.name) edit((d) => updateArea(d, area.id, { name: renaming.trim() }));
    setRenaming(null);
  };

  return (
    <div className={`area-node${area.collapsed ? ' collapsed' : ''}${selected ? ' selected' : ''}`} style={{ ['--area-color' as string]: area.color }}>
      {!readOnly && !area.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={200}
          minHeight={120}
          color={area.color}
          onResizeEnd={(_, p) =>
            edit((d) => {
              updateArea(d, area.id, { position: { x: Math.round(p.x), y: Math.round(p.y) }, size: { width: Math.round(p.width), height: Math.round(p.height) } });
              assignAreas(d, 'all', measuredSizeOf());
            })
          }
        />
      )}
      <div className="area-node__header">
        <button
          className="area-node__toggle nodrag"
          title={area.collapsed ? '펼치기' : '접기 (안의 테이블 숨기기)'}
          disabled={readOnly}
          onClick={() => edit((d) => updateArea(d, area.id, { collapsed: !area.collapsed }))}
        >
          {area.collapsed ? '▸' : '▾'}
        </button>
        {renaming !== null ? (
          <input
            className="area-node__name-input nodrag"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') setRenaming(null);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="area-node__name" title={readOnly ? area.name : '더블클릭해서 이름 바꾸기'} onDoubleClick={() => !readOnly && setRenaming(area.name)}>
            {area.name}
          </span>
        )}
        <span className="area-node__count">테이블 {tableNames.length}개</span>
        {!readOnly && (
          <span className="area-node__tools nodrag">
            <button title="색상" onClick={() => setPicking(!picking)}>●</button>
            <button
              title="영역 지우기 (테이블은 남습니다)"
              onClick={() => edit((d) => removeArea(d, area.id))}
            >
              ×
            </button>
          </span>
        )}
        {picking && (
          <div className="area-node__colors nodrag">
            {AREA_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                className={c === area.color ? 'active' : ''}
                onClick={() => {
                  edit((d) => updateArea(d, area.id, { color: c }));
                  setPicking(false);
                }}
              />
            ))}
          </div>
        )}
      </div>
      {area.collapsed && tableNames.length > 0 && (
        <div className="area-node__list">
          {tableNames.slice(0, 8).join(', ')}
          {tableNames.length > 8 ? ` 외 ${tableNames.length - 8}개` : ''}
        </div>
      )}
    </div>
  );
}

export const AreaNode = memo(AreaNodeView);
