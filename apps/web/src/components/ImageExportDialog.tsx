import { useMemo, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import { useStore } from '../store';
import { useProjectName } from '../lib/hooks';
import { downloadBlob, safeFileName } from '../lib/download';
import { exportDiagram, exportSize, pngScale, type ExportTarget } from '../lib/exportImage';
import { Modal } from './Modal';

type Range = 'all' | 'visible' | 'related';
type Format = 'png' | 'svg';

const RANGE_LABEL: Record<Range, string> = { all: '전체 ERD', visible: '지금 화면에 보이는 부분', related: '선택한 테이블 + 연결된 테이블' };

/** 이미지로 내보내기: 범위(전체 / 지금 화면 / 선택한 테이블 주변)와 형식을 고른다 */
export function ImageExportDialog({ onClose }: { onClose: () => void }) {
  const projectName = useProjectName();
  const selection = useStore((s) => s.selection);
  const selectedTable = selection?.type === 'table' ? selection.id : null;
  const { getNodes, getEdges, getNodesBounds, screenToFlowPosition } = useReactFlow();
  const [range, setRange] = useState<Range>(selectedTable ? 'related' : 'all');
  const [format, setFormat] = useState<Format>('png');
  const [busy, setBusy] = useState(false);

  // 범위마다 들어갈 테이블과 관계선
  const targets = useMemo(() => {
    const nodes = getNodes();
    const edges = getEdges();
    const withEdges = (picked: Node[]): ExportTarget => {
      const ids = new Set(picked.map((n) => n.id));
      return { nodes: picked, edgeIds: new Set(edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => e.id)) };
    };
    // 화면에 조금이라도 보이는 테이블
    const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
    let visible: Node[] = [];
    if (pane) {
      const a = screenToFlowPosition({ x: pane.left, y: pane.top });
      const b = screenToFlowPosition({ x: pane.right, y: pane.bottom });
      visible = nodes.filter((n) => {
        const w = n.measured?.width ?? 0;
        const h = n.measured?.height ?? 0;
        return n.position.x + w > a.x && n.position.x < b.x && n.position.y + h > a.y && n.position.y < b.y;
      });
    }
    // 선택한 테이블과 관계로 바로 이어진 테이블
    const related = new Set(selectedTable ? [selectedTable] : []);
    if (selectedTable) for (const e of edges) if (e.source === selectedTable || e.target === selectedTable) related.add(e.source).add(e.target);
    return {
      all: { nodes, edgeIds: null } as ExportTarget,
      visible: withEdges(visible),
      related: withEdges(nodes.filter((n) => related.has(n.id))),
    };
  }, [getNodes, getEdges, screenToFlowPosition, selectedTable]);

  const target = targets[range];
  const size = target.nodes.length ? exportSize(target, getNodesBounds) : null;
  const scale = size ? pngScale(size.width, size.height) : 1;
  const bigForPng = size !== null && scale < 2;

  const download = async () => {
    setBusy(true);
    try {
      const blob = await exportDiagram(target, getNodesBounds, format);
      const suffix = range === 'all' ? '' : range === 'visible' ? '_화면' : `_${useStore.getState().schema.tables.find((t) => t.id === selectedTable)?.name ?? '선택'}`;
      downloadBlob(blob, `${safeFileName(projectName + suffix)}.${format}`);
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="이미지로 내보내기"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={busy || !target.nodes.length} onClick={download}>{busy ? '만드는 중…' : '다운로드'}</button>
        </>
      }
    >
      <div className="form-grid wide-label">
        <label>범위</label>
        <div className="radio-list">
          {(['all', 'visible', 'related'] as Range[]).map((r) => (
            <label key={r} className={r === 'related' && !selectedTable ? 'disabled' : ''}>
              <input type="radio" name="range" checked={range === r} disabled={r === 'related' && !selectedTable} onChange={() => setRange(r)} />
              {RANGE_LABEL[r]}
              <span className="muted small"> · 테이블 {targets[r].nodes.length}개{r === 'related' && !selectedTable ? ' (먼저 테이블을 클릭하세요)' : ''}</span>
            </label>
          ))}
        </div>
        <label>형식</label>
        <div className="segmented">
          <button className={format === 'png' ? 'active' : ''} onClick={() => setFormat('png')}>PNG</button>
          <button className={format === 'svg' ? 'active' : ''} onClick={() => setFormat('svg')}>SVG (벡터)</button>
        </div>
      </div>
      {size && (
        <div className="baseline-info">
          {format === 'png'
            ? `PNG ${Math.round(size.width * scale).toLocaleString()} × ${Math.round(size.height * scale).toLocaleString()} px (화면 100% 대비 ${scale.toFixed(scale < 1 ? 2 : 1)}배)`
            : `SVG ${size.width.toLocaleString()} × ${size.height.toLocaleString()} · 벡터라 아무리 확대해도 깨지지 않습니다`}
        </div>
      )}
      <p className="muted small">
        {format === 'png' && bigForPng
          ? 'ERD가 커서 PNG 해상도에 한계가 있습니다. 확대해서 보려면 SVG를 쓰거나, 필요한 부분을 화면에 크게 띄운 뒤 "지금 화면에 보이는 부분"으로 내보내세요.'
          : '전체를 한 장에 넣으면 테이블이 작게 보입니다. 특정 부분만 크게 필요하면 화면을 그 부분으로 옮긴 뒤 "지금 화면에 보이는 부분"을 고르세요.'}
        {' '}SVG는 브라우저·PPT·Figma 등에서 확대해도 선명합니다.
      </p>
    </Modal>
  );
}
