import type { Node, Rect } from '@xyflow/react';
import { foreignKeyColumnIds, type Schema } from '@erd/core';
import { diagramToSvg, type ExportTarget } from './exportImage';

// ERD를 HTML 파일 하나로 내보낸다. 인터넷·서버 없이 더블클릭으로 열리고,
// 벡터 도면을 휠로 확대·끌어서 이동하며, 테이블 목록·검색·컬럼 상세를 볼 수 있다.

interface HtmlColumn { name: string; logical: string; type: string; pk: boolean; fk: boolean; nn: boolean; uq: boolean; ai: boolean; def: string; comment: string }
interface HtmlTable {
  id: string;
  name: string;
  logical: string;
  comment: string;
  columns: HtmlColumn[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  refs: { table: string; id: string; columns: string; dir: 'out' | 'in' }[];
}

function tableData(schema: Schema, ids: Set<string>): HtmlTable[] {
  const nameOf = (id: string) => schema.tables.find((t) => t.id === id)?.name ?? '?';
  return schema.tables
    .filter((t) => ids.has(t.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const fk = foreignKeyColumnIds(schema, t.id);
      const col = (id: string) => t.columns.find((c) => c.id === id)?.name ?? '?';
      return {
        id: t.id,
        name: t.name,
        logical: t.logicalName ?? '',
        comment: t.comment ?? '',
        columns: t.columns.map((c) => ({
          name: c.name,
          logical: c.logicalName ?? '',
          type: c.type + (c.length ? `(${c.length})` : ''),
          pk: c.primaryKey,
          fk: fk.has(c.id),
          nn: !c.nullable || c.primaryKey,
          uq: Boolean(c.unique),
          ai: Boolean(c.autoIncrement),
          def: c.defaultValue ?? '',
          comment: c.comment ?? '',
        })),
        indexes: t.indexes.map((i) => ({ name: i.name ?? '', unique: i.unique, columns: i.columnIds.map(col) })),
        refs: schema.relations.flatMap((r) => {
          const out: HtmlTable['refs'] = [];
          if (r.fromTableId === t.id) out.push({ table: nameOf(r.toTableId), id: r.toTableId, columns: r.fromColumnIds.map(col).join(', '), dir: 'out' });
          if (r.toTableId === t.id && r.fromTableId !== t.id) {
            const child = schema.tables.find((x) => x.id === r.fromTableId);
            out.push({ table: nameOf(r.fromTableId), id: r.fromTableId, columns: r.fromColumnIds.map((cid) => child?.columns.find((c) => c.id === cid)?.name ?? '?').join(', '), dir: 'in' });
          }
          return out;
        }),
      };
    });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** <script> 안에 넣어도 안전한 JSON */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function diagramToHtml(target: ExportTarget, getNodesBounds: (nodes: Node[]) => Rect, schema: Schema, info: { projectName: string; dialect: string }): Blob {
  const { svg } = diagramToSvg(target, getNodesBounds);
  const tables = tableData(schema, new Set(target.nodes.map((n) => n.id)));
  const exportedAt = new Date().toLocaleString('ko-KR');
  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.projectName)} · ERD</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="title"><b>${esc(info.projectName)}</b><span>${esc(info.dialect)} · 테이블 ${tables.length}개 · ${esc(exportedAt)} 내보냄</span></div>
  <div class="tools">
    <button id="zoomOut" title="축소">−</button><span id="zoomLabel">100%</span><button id="zoomIn" title="확대">+</button>
    <button id="fit" title="전체 보기">전체 보기</button>
  </div>
</header>
<main>
  <aside>
    <input id="q" type="search" placeholder="테이블·컬럼 찾기 (Ctrl+F)" autocomplete="off">
    <ul id="list"></ul>
    <section id="detail" hidden></section>
  </aside>
  <div id="stage">${svg}</div>
</main>
<script>const TABLES = ${safeJson(tables)};</script>
<script>${JS}</script>
</body>
</html>`;
  return new Blob([html], { type: 'text/html;charset=utf-8' });
}

const CSS = `
*{box-sizing:border-box}
:root{--bg:#f8fafc;--panel:#fff;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--accent:#2563eb;--hl:#fde68a}
html,body{margin:0;height:100%}
body{font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;color:var(--text);background:var(--bg);display:flex;flex-direction:column;font-size:13px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--border)}
header .title{display:flex;align-items:baseline;gap:10px;min-width:0}
header .title b{font-size:15px}
header .title span{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tools{display:flex;align-items:center;gap:4px}
.tools button{border:1px solid var(--border);background:var(--panel);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
.tools button:hover{border-color:var(--accent);color:var(--accent)}
#zoomLabel{min-width:48px;text-align:center;color:var(--muted)}
main{flex:1;display:flex;min-height:0}
aside{width:300px;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--panel);min-height:0}
#q{margin:10px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font:inherit}
#list{list-style:none;margin:0;padding:0 6px 6px;overflow:auto;flex:1}
#list li{padding:5px 8px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
#list li:hover{background:#f1f5f9}
#list li.active{background:#dbeafe}
#list li small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#list .hit{font-size:11px;color:var(--muted);padding:0 8px 4px 16px;cursor:pointer}
#detail{border-top:1px solid var(--border);overflow:auto;max-height:55%;padding:10px 12px}
#detail h3{margin:0 0 2px;font-size:14px}
#detail .sub{color:var(--muted);margin-bottom:8px}
#detail table{width:100%;border-collapse:collapse;font-size:12px}
#detail th,#detail td{border-bottom:1px solid var(--border);padding:3px 4px;text-align:left;vertical-align:top}
#detail th{color:var(--muted);font-weight:500}
#detail td.k{white-space:nowrap}
#detail .tag{display:inline-block;font-size:10px;font-weight:700;border-radius:3px;padding:0 3px;margin-right:2px}
.tag.pk{background:#fcd34d}.tag.fk{background:#ddd6fe;color:#5b21b6}.tag.uq{background:#e2e8f0}
#detail h4{margin:10px 0 4px;font-size:12px;color:var(--muted)}
#detail a{color:var(--accent);cursor:pointer;text-decoration:none}
#stage{flex:1;overflow:hidden;position:relative;cursor:grab;background:#f1f5f9}
#stage.drag{cursor:grabbing}
#stage>svg{position:absolute;left:0;top:0;width:100%;height:100%;user-select:none}
#stage g[data-table-id]{cursor:pointer}
#stage g.dim{opacity:.25}
#stage .sel-box{fill:none;stroke:#f59e0b;stroke-width:4;pointer-events:none}
@media (max-width:760px){aside{width:220px}header .title span{display:none}}
@media print{aside,header .tools{display:none}#stage{overflow:visible}}
`;

// 화면 동작: viewBox로 확대·이동, 목록·검색·상세
const JS = `
(() => {
  const stage = document.getElementById('stage');
  const svg = stage.querySelector('svg');
  const full = svg.viewBox.baseVal;
  const W = full.width, H = full.height;
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // 배경은 도면 영역만 (화면을 옮겨도 종이처럼 고정)
  const paper = svg.querySelector(':scope > rect');
  if (paper) { paper.setAttribute('width', W); paper.setAttribute('height', H); }
  const groups = new Map([...svg.querySelectorAll('g[data-table-id]')].map((g) => [g.getAttribute('data-table-id'), g]));
  const byId = new Map(TABLES.map((t) => [t.id, t]));
  let vb = { x: 0, y: 0, w: W, h: H };
  const label = document.getElementById('zoomLabel');

  function apply() {
    svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
    const r = stage.getBoundingClientRect();
    const scale = Math.min(r.width / vb.w, r.height / vb.h);
    label.textContent = Math.round(scale * 100) + '%';
  }
  function fitTo(x, y, w, h, pad) {
    const r = stage.getBoundingClientRect();
    pad = pad || 40;
    w += pad * 2; h += pad * 2; x -= pad; y -= pad;
    // 화면 비율에 맞춘다
    const ratio = r.width / r.height;
    if (w / h > ratio) { const nh = w / ratio; y -= (nh - h) / 2; h = nh; } else { const nw = h * ratio; x -= (nw - w) / 2; w = nw; }
    vb = { x, y, w, h };
    apply();
  }
  function fitAll() { fitTo(0, 0, W, H, 0); }
  function zoomAt(factor, cx, cy) {
    const r = stage.getBoundingClientRect();
    const px = cx === undefined ? 0.5 : (cx - r.left) / r.width;
    const py = cy === undefined ? 0.5 : (cy - r.top) / r.height;
    const nw = Math.min(Math.max(vb.w / factor, 40), W * 20);
    const nh = nw * (vb.h / vb.w);
    vb = { x: vb.x + (vb.w - nw) * px, y: vb.y + (vb.h - nh) * py, w: nw, h: nh };
    apply();
  }
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vb: { ...vb }, moved: false }; stage.setPointerCapture(e.pointerId); stage.classList.add('drag'); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    const k = Math.max(vb.w / r.width, vb.h / r.height);
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    vb = { ...vb, x: drag.vb.x - dx * k, y: drag.vb.y - dy * k };
    apply();
  });
  stage.addEventListener('pointerup', (e) => {
    const wasClick = drag && !drag.moved;
    drag = null; stage.classList.remove('drag');
    if (wasClick) {
      const g = document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest && el.closest('g[data-table-id]')).find(Boolean);
      if (g) select(g.getAttribute('data-table-id'), false);
    }
  });
  document.getElementById('zoomIn').onclick = () => zoomAt(1.3);
  document.getElementById('zoomOut').onclick = () => zoomAt(1 / 1.3);
  document.getElementById('fit').onclick = fitAll;
  window.addEventListener('resize', apply);

  // 고른 테이블 강조 + 상세
  const NS = 'http://www.w3.org/2000/svg';
  let selBox = null, current = null;
  function boxOf(id) {
    const g = groups.get(id); if (!g) return null;
    const b = g.getBBox();
    const t = g.parentNode.transform.baseVal.consolidate();
    const m = t ? t.matrix : { e: 0, f: 0 };
    return { x: b.x + m.e, y: b.y + m.f, w: b.width, h: b.height };
  }
  function select(id, move) {
    current = id;
    const b = boxOf(id);
    if (selBox) selBox.remove();
    if (b) {
      selBox = document.createElementNS(NS, 'rect');
      selBox.setAttribute('class', 'sel-box');
      selBox.setAttribute('x', b.x - 4); selBox.setAttribute('y', b.y - 4);
      selBox.setAttribute('width', b.w + 8); selBox.setAttribute('height', b.h + 8); selBox.setAttribute('rx', 10);
      svg.appendChild(selBox);
      if (move) { const r = stage.getBoundingClientRect(); const w = Math.max(b.w * 3, r.width * 0.9); const h = Math.max(b.h + 80, w * r.height / r.width); fitTo(b.x + b.w / 2 - w / 2, b.y + b.h / 2 - h / 2, w, h, 20); }
    }
    renderList();
    renderDetail(byId.get(id));
  }
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function renderDetail(t) {
    const el = document.getElementById('detail');
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    const cols = t.columns.map((c) => '<tr><td class="k">' + (c.pk ? '<span class="tag pk">PK</span>' : '') + (c.fk ? '<span class="tag fk">FK</span>' : '') + (c.uq && !c.pk ? '<span class="tag uq">UQ</span>' : '') + '</td>' +
      '<td><b>' + escHtml(c.name) + '</b>' + (c.logical ? '<br><small>' + escHtml(c.logical) + '</small>' : '') + '</td>' +
      '<td>' + escHtml(c.type) + (c.nn ? ' NN' : '') + (c.ai ? ' AI' : '') + (c.def ? '<br><small>기본 ' + escHtml(c.def) + '</small>' : '') + (c.comment && c.comment !== c.logical ? '<br><small>' + escHtml(c.comment) + '</small>' : '') + '</td></tr>').join('');
    const idx = t.indexes.length ? '<h4>인덱스</h4>' + t.indexes.map((i) => '<div>' + (i.unique ? 'UNIQUE ' : '') + escHtml(i.name || '') + ' (' + escHtml(i.columns.join(', ')) + ')</div>').join('') : '';
    const refs = t.refs.length ? '<h4>관계</h4>' + t.refs.map((r) => '<div>' + (r.dir === 'out' ? '→ ' : '← ') + '<a data-go="' + escHtml(r.id) + '">' + escHtml(r.table) + '</a> <small>(' + escHtml(r.columns) + ')</small></div>').join('') : '';
    el.innerHTML = '<h3>' + escHtml(t.name) + '</h3><div class="sub">' + escHtml([t.logical, t.comment].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ')) + '</div>' +
      '<table><thead><tr><th></th><th>컬럼</th><th>타입</th></tr></thead><tbody>' + cols + '</tbody></table>' + idx + refs;
  }
  document.getElementById('detail').addEventListener('click', (e) => { const a = e.target.closest('a[data-go]'); if (a) select(a.getAttribute('data-go'), true); });

  // 목록·검색: 맞지 않는 테이블은 도면에서 흐리게
  const q = document.getElementById('q');
  function matches(t, s) {
    if (!s) return { ok: true, cols: [] };
    const has = (v) => v && v.toLowerCase().includes(s);
    const cols = t.columns.filter((c) => has(c.name) || has(c.logical) || has(c.comment)).map((c) => c.name);
    return { ok: has(t.name) || has(t.logical) || has(t.comment) || cols.length > 0, cols };
  }
  function renderList() {
    const s = q.value.trim().toLowerCase();
    const list = document.getElementById('list');
    list.innerHTML = '';
    for (const t of TABLES) {
      const m = matches(t, s);
      const g = groups.get(t.id);
      if (g) g.classList.toggle('dim', !m.ok);
      if (!m.ok) continue;
      const li = document.createElement('li');
      li.className = t.id === current ? 'active' : '';
      li.innerHTML = '<span>' + escHtml(t.name) + '</span><small>' + escHtml(t.logical) + '</small>';
      li.onclick = () => select(t.id, true);
      list.appendChild(li);
      if (s && m.cols.length) {
        const hit = document.createElement('div');
        hit.className = 'hit';
        hit.textContent = '컬럼: ' + m.cols.join(', ');
        hit.onclick = () => select(t.id, true);
        list.appendChild(hit);
      }
    }
  }
  q.addEventListener('input', renderList);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = TABLES.find((t) => matches(t, q.value.trim().toLowerCase()).ok); if (first) select(first.id, true); } });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); q.focus(); q.select(); }
    if (e.key === 'Escape') { q.value = ''; renderList(); }
  });

  renderList();
  fitAll();
})();
`;
