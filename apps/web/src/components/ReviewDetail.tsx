import type { AiReviewDetail } from '@erd/core';

/** 마크다운 표(| a | b |)는 표로, 나머지는 문단으로 */
function RichText({ text }: { text: string }) {
  const blocks: ({ kind: 'table'; rows: string[][] } | { kind: 'p'; text: string })[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const last = blocks.at(-1);
    if (/^\|.*\|$/.test(trimmed)) {
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // 구분선 |---|---|
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (last?.kind === 'table') last.rows.push(cells);
      else blocks.push({ kind: 'table', rows: [cells] });
    } else if (trimmed) {
      if (last?.kind === 'p') last.text += `\n${trimmed}`;
      else blocks.push({ kind: 'p', text: trimmed });
    } else blocks.push({ kind: 'p', text: '' });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'table' ? (
          <table key={i} className="review-detail__table">
            <thead>
              <tr>{b.rows[0]!.map((c, j) => <th key={j}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.slice(1).map((r, k) => (
                <tr key={k}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        ) : b.text ? (
          <p key={i}>{b.text}</p>
        ) : null,
      )}
    </>
  );
}

/** AI 검토 항목의 상세 설명 (펼쳐 보기) */
export function ReviewDetail({ detail, onAsk }: { detail: AiReviewDetail; onAsk: () => void }) {
  const section = (title: string, body?: string) =>
    body ? (
      <section>
        <h5>{title}</h5>
        <RichText text={body} />
      </section>
    ) : null;
  return (
    <div className="review-detail">
      {section('무슨 상황인지', detail.situation)}
      {section('예시', detail.example)}
      {section('생길 수 있는 일', detail.impact)}
      {detail.options?.length ? (
        <section>
          <h5>고치는 방법</h5>
          <ol className="review-detail__options">
            {detail.options.map((o, i) => (
              <li key={i}>
                <b>{o.name}</b>
                {o.how && <div>{o.how}</div>}
                {o.pros && <div className="review-detail__pro">장점: {o.pros}</div>}
                {o.cons && <div className="review-detail__con">단점: {o.cons}</div>}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {section('앱에서 처리해도 되나', detail.appLevel)}
      {section('전제', detail.assumption)}
      <button className="btn btn-ghost small" onClick={onAsk}>이 항목 AI에게 묻기</button>
    </div>
  );
}
