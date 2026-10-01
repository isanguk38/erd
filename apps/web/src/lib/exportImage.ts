import { getViewportForBounds, type Node, type Rect } from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';

const PADDING = 40;

/** 캔버스 전체(모든 테이블)를 이미지로 만든다. 화면 확대/이동과 관계없이 전체가 들어간다. */
export async function exportDiagram(nodes: Node[], getNodesBounds: (nodes: Node[]) => Rect, format: 'png' | 'svg'): Promise<string> {
  const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewportEl || nodes.length === 0) throw new Error('내보낼 테이블이 없습니다');
  const bounds = getNodesBounds(nodes);
  const width = Math.ceil(bounds.width + PADDING * 2);
  const height = Math.ceil(bounds.height + PADDING * 2);
  const viewport = getViewportForBounds(bounds, width, height, 0.1, 2, PADDING);
  const background = getComputedStyle(document.body).getPropertyValue('--canvas-bg').trim() || '#ffffff';
  const options = {
    backgroundColor: background,
    width,
    height,
    pixelRatio: 2,
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
  };
  return format === 'png' ? toPng(viewportEl, options) : toSvg(viewportEl, options);
}
