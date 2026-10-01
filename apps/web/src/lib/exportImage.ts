import type { Node, Rect } from '@xyflow/react';

// ERD 이미지 내보내기.
// 화면을 캡처하지 않고, 화면에 그려진 테이블·글자·관계선을 진짜 벡터(rect/text/path)로 옮겨 SVG를 만든다.
// SVG는 아무리 확대해도 깨지지 않고, PNG는 그 SVG를 브라우저 한계 안에서 가장 크게(최대 4배) 그린다.

const PADDING = 40;
/** 브라우저 캔버스 한계 (한 변, 전체 픽셀) */
const MAX_SIDE = 16384;
const MAX_AREA = 200_000_000;
const MAX_SCALE = 4;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => String(Math.round(n * 100) / 100);
const visibleColor = (c: string) => Boolean(c) && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);

/** 화면 좌표 → ERD(플로우) 좌표 */
function flowMapper(viewportEl: HTMLElement) {
  const m = new DOMMatrixReadOnly(getComputedStyle(viewportEl).transform);
  const origin = viewportEl.parentElement!.getBoundingClientRect();
  return (r: DOMRect) => ({
    x: (r.left - origin.left - m.e) / m.a,
    y: (r.top - origin.top - m.f) / m.a,
    w: r.width / m.a,
    h: r.height / m.a,
    zoom: m.a,
  });
}

const SKIP = '.react-flow__handle, .peer-tags';

/** 테이블 하나를 SVG 조각으로 */
function nodeToSvg(nodeEl: HTMLElement, toFlow: ReturnType<typeof flowMapper>, clipId: string): string {
  const out: string[] = [];
  const nodeStyle = getComputedStyle(nodeEl);
  const box = toFlow(nodeEl.getBoundingClientRect());
  const radius = parseFloat(nodeStyle.borderTopLeftRadius) || 0;
  const opacity = parseFloat(nodeStyle.opacity);
  out.push(`<clipPath id="${clipId}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" rx="${num(radius)}"/></clipPath>`);
  out.push(`<g clip-path="url(#${clipId})"${opacity < 1 ? ` opacity="${opacity}"` : ''}>`);

  const borders: string[] = [];
  const walk = (el: HTMLElement) => {
    if (el !== nodeEl && el.matches(SKIP)) return;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const r = toFlow(el.getBoundingClientRect());
    if (r.w > 0 && r.h > 0) {
      const rx = parseFloat(st.borderTopLeftRadius) || 0;
      if (visibleColor(st.backgroundColor)) {
        out.push(`<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" rx="${num(rx)}" fill="${st.backgroundColor}"/>`);
      }
      // 테두리: 네 면이 같으면 사각형, 아니면 면마다 선 (헤더 아래 구분선 등)
      const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).map((s) => ({
        s,
        w: parseFloat(st.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0,
        c: st.getPropertyValue(`border-${s.toLowerCase()}-color`),
        style: st.getPropertyValue(`border-${s.toLowerCase()}-style`),
      })).filter((b) => b.w > 0 && b.style !== 'none' && visibleColor(b.c));
      const target = el === nodeEl ? borders : out;
      if (sides.length === 4 && sides.every((b) => b.w === sides[0].w && b.c === sides[0].c)) {
        const w = sides[0].w;
        target.push(`<rect x="${num(r.x + w / 2)}" y="${num(r.y + w / 2)}" width="${num(r.w - w)}" height="${num(r.h - w)}" rx="${num(rx)}" fill="none" stroke="${sides[0].c}" stroke-width="${num(w)}"/>`);
      } else {
        for (const b of sides) {
          const h = b.w / 2;
          const [x1, y1, x2, y2] = {
            Top: [r.x, r.y + h, r.x + r.w, r.y + h],
            Bottom: [r.x, r.y + r.h - h, r.x + r.w, r.y + r.h - h],
            Left: [r.x + h, r.y, r.x + h, r.y + r.h],
            Right: [r.x + r.w - h, r.y, r.x + r.w - h, r.y + r.h],
          }[b.s];
          target.push(`<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${b.c}" stroke-width="${num(b.w)}"${b.style === 'dashed' ? ' stroke-dasharray="4 3"' : ''}/>`);
        }
      }
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3 /* 글자 */) {
        const text = child.textContent ?? '';
        if (!text.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const tr = toFlow(range.getBoundingClientRect());
        if (tr.w <= 0) continue;
        const fontSize = parseFloat(st.fontSize);
        const family = st.fontFamily.replace(/"/g, "'");
        // 글자 폭을 화면과 똑같이 맞춰, 다른 PC(다른 글꼴)에서 열어도 칸을 넘치지 않게 한다
        out.push(
          `<text x="${num(tr.x)}" y="${num(tr.y + tr.h / 2)}" dominant-baseline="central" font-family="${esc(family)}" font-size="${num(fontSize)}" font-weight="${st.fontWeight}"` +
            `${st.fontStyle === 'italic' ? ' font-style="italic"' : ''} fill="${st.color}" textLength="${num(tr.w)}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${esc(text.trim())}</text>`,
        );
      } else if (child instanceof HTMLElement) {
        walk(child);
      }
    }
  };
  walk(nodeEl);
  out.push('</g>');
  // 바깥 테두리는 잘리지 않게 맨 위에
  out.push(...borders);
  return out.join('');
}

/** 관계선: 화면의 path를 그대로 (좌표가 이미 ERD 좌표). edgeIds가 있으면 그 관계만 */
function edgesToSvg(viewportEl: HTMLElement, edgeIds: Set<string> | null): string {
  const out: string[] = [];
  for (const edgeEl of viewportEl.querySelectorAll<SVGGElement>('.react-flow__edge')) {
    const id = edgeEl.getAttribute('data-testid')?.replace(/^rf__edge-/, '') ?? edgeEl.getAttribute('data-id') ?? '';
    if (edgeIds && !edgeIds.has(id)) continue;
    for (const path of edgeEl.querySelectorAll<SVGPathElement>('path')) {
      if (path.classList.contains('react-flow__edge-interaction')) continue;
      const st = getComputedStyle(path);
      const d = path.getAttribute('d');
      if (!d || st.display === 'none' || st.visibility === 'hidden') continue;
      const stroke = st.stroke;
      if (!visibleColor(stroke) || stroke === 'none') continue;
      const dash = st.strokeDasharray && st.strokeDasharray !== 'none' ? ` stroke-dasharray="${st.strokeDasharray.replace(/px/g, '')}"` : '';
      out.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${parseFloat(st.strokeWidth) || 1}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
    }
  }
  return out.join('');
}

/** 내보낼 범위: 테이블들과 그 사이 관계선 (edgeIds가 null이면 모든 관계선) */
export interface ExportTarget {
  nodes: Node[];
  edgeIds: Set<string> | null;
}

/** 이미지 크기 (여백 포함, ERD 좌표 1 = 1px) */
export function exportSize(nodes: Node[], getNodesBounds: (nodes: Node[]) => Rect): { width: number; height: number } {
  const bounds = getNodesBounds(nodes);
  return { width: Math.ceil(bounds.width + PADDING * 2), height: Math.ceil(bounds.height + PADDING * 2) };
}

/** 화면의 ERD를 벡터 SVG 문자열로 */
export function diagramToSvg({ nodes, edgeIds }: ExportTarget, getNodesBounds: (nodes: Node[]) => Rect): { svg: string; width: number; height: number } {
  const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewportEl || nodes.length === 0) throw new Error('내보낼 테이블이 없습니다');
  const toFlow = flowMapper(viewportEl);
  const bounds = getNodesBounds(nodes);
  const { width, height } = exportSize(nodes, getNodesBounds);
  const background = getComputedStyle(document.body).getPropertyValue('--canvas-bg').trim() || '#ffffff';
  const ids = new Set(nodes.map((n) => n.id));
  const parts = [...viewportEl.querySelectorAll<HTMLElement>('.react-flow__node')]
    .filter((el) => ids.has(el.dataset.id ?? ''))
    .map((el, i) => nodeToSvg((el.firstElementChild as HTMLElement) ?? el, toFlow, `c${i}`));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="${background}"/>` +
    `<g transform="translate(${num(PADDING - bounds.x)} ${num(PADDING - bounds.y)})">${edgesToSvg(viewportEl, edgeIds)}${parts.join('')}</g></svg>`;
  return { svg, width, height };
}

/** 이 크기의 그림을 PNG로 얼마나 크게 그릴 수 있는지 */
export function pngScale(width: number, height: number): number {
  return Math.max(0.1, Math.min(MAX_SCALE, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height))));
}

/** ERD를 SVG 또는 고해상도 PNG 파일로 */
export async function exportDiagram(target: ExportTarget, getNodesBounds: (nodes: Node[]) => Rect, format: 'png' | 'svg'): Promise<Blob> {
  const { svg, width, height } = diagramToSvg(target, getNodesBounds);
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  if (format === 'svg') return svgBlob;

  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const scale = pngScale(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('이미지를 만들 수 없습니다 (캔버스 생성 실패)');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG를 만들 수 없습니다'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
