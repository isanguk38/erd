import { useMemo, useState } from 'react';
import { useReactFlow, type Node } from '@xyflow/react';
import { useStore } from '../store';
import { useDialect, useProjectName } from '../lib/hooks';
import { diagramToHtml } from '../lib/exportHtml';
import { getDialect } from '@erd/core';
import { downloadBlob, safeFileName } from '../lib/download';
import { exportDiagram, exportSize, pngScale, type ExportTarget } from '../lib/exportImage';
import { Modal } from './Modal';

type Range = 'all' | 'visible';
type Format = 'png' | 'svg' | 'html';

const RANGE_LABEL: Record<Range, string> = { all: '전체 ERD', visible: '지금 화면에 보이는 부분' };

/** ERD 도면 내보내기: 범위(전체 / 지금 화면)와 형식(HTML·PNG·SVG)을 고른다 */
export function ImageExportDialog({ onClose }: { onClose: () => void }) {
  const projectName = useProjectName();
  const dialect = useDialect();
  const { getNodes, getEdges, getNodesBounds, screenToFlowPosition } = useReactFlow();
  const [range, setRange] = useState<Range>('all');
  // 주제영역 탭에서 열면 그 영역(과 영역 밖 참조 카드)이 '전체'다
  const area = useStore((s) => (s.activeArea ? s.schema.areas?.find((a) => a.id === s.activeArea) : undefined));
  const rangeLabel = (r: Range) => (r === 'all' && area ? `${area.name} 영역 전체` : RANGE_LABEL[r]);
  const [format, setFormat] = useState<Format>('html');
  const [busy, setBusy] = useState(false);

  // 범위마다 들어갈 테이블과 관계선
  const targets = useMemo(() => {
    // 지금 캔버스에 그려진 것 그대로 (주제영역 탭이면 그 영역 테이블과 영역 밖 참조 카드)
    const nodes = getNodes().filter((n) => !n.hidden);
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
    return {
      all: withEdges(nodes),
      visible: withEdges(visible),
    } as Record<Range, ExportTarget>;
  }, [getNodes, getEdges, screenToFlowPosition]);
  const tableCount = (r: Range) => targets[r].nodes.filter((n) => n.type === 'table').length;

  const target = targets[range];
  const size = target.nodes.length ? exportSize(target, getNodesBounds) : null;
  const scale = size ? pngScale(size.width, size.height) : 1;
  const bigForPng = size !== null && scale < 2;

  const download = async () => {
    setBusy(true);
    try {
      const blob =
        format === 'html'
          ? diagramToHtml(target, getNodesBounds, useStore.getState().schema, { projectName, dialect: getDialect(dialect).label })
          : await exportDiagram(target, getNodesBounds, format);
      const suffix = `${area ? `_${area.name}` : ''}${range === 'all' ? '' : '_화면'}`;
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
      title="ERD 내보내기 (HTML · 이미지)"
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
          {(['all', 'visible'] as Range[]).map((r) => (
            <label key={r}>
              <input type="radio" name="range" checked={range === r} onChange={() => setRange(r)} />
              {rangeLabel(r)}
              <span className="muted small"> · 테이블 {tableCount(r)}개</span>
            </label>
          ))}
        </div>
        <label>형식</label>
        <div className="segmented">
          <button className={format === 'html' ? 'active' : ''} onClick={() => setFormat('html')}>HTML (보기용)</button>
          <button className={format === 'png' ? 'active' : ''} onClick={() => setFormat('png')}>PNG</button>
          <button className={format === 'svg' ? 'active' : ''} onClick={() => setFormat('svg')}>SVG (벡터)</button>
        </div>
      </div>
      {size && (
        <div className="baseline-info">
          {format === 'html'
            ? `HTML 파일 하나 · 브라우저로 열면 휠로 확대·끌어서 이동, 테이블 검색(Ctrl+F), 클릭하면 컬럼·인덱스·관계 상세`
            : format === 'png'
            ? `PNG ${Math.round(size.width * scale).toLocaleString()} × ${Math.round(size.height * scale).toLocaleString()} px (화면 100% 대비 ${scale.toFixed(scale < 1 ? 2 : 1)}배)`
            : `SVG ${size.width.toLocaleString()} × ${size.height.toLocaleString()} · 벡터라 아무리 확대해도 깨지지 않습니다`}
        </div>
      )}
      <p className="muted small">
        {format === 'html'
          ? '인터넷이나 이 서비스 계정 없이도 열립니다. 메일·메신저로 보내거나 위키에 첨부해 공유하기 좋습니다. 벡터라 확대해도 깨지지 않습니다.'
          : format === 'png' && bigForPng
          ? 'ERD가 커서 PNG 해상도에 한계가 있습니다. 확대해서 보려면 SVG를 쓰거나, 필요한 부분을 화면에 크게 띄운 뒤 "지금 화면에 보이는 부분"으로 내보내세요.'
          : '전체를 한 장에 넣으면 테이블이 작게 보입니다. 특정 부분만 크게 필요하면 화면을 그 부분으로 옮긴 뒤 "지금 화면에 보이는 부분"을 고르세요.'}
        {format !== 'html' && ' SVG는 브라우저·PPT·Figma 등에서 확대해도 선명합니다.'}
      </p>
    </Modal>
  );
}
