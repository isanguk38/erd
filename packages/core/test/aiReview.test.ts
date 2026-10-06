import { describe, expect, it } from 'vitest';
import { applyCommands, buildReview, emptySchema, resolveReviewItems, reviewItemId, reviewItemState } from '../src';

const design = () =>
  applyCommands(emptySchema(), [
    { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }, { name: 'email', type: 'VARCHAR(100)' }] },
    { op: 'createTable', name: 'orders', columns: [{ name: 'order_id', type: 'BIGINT', primaryKey: true }] },
    { op: 'addRelation', parent: 'member', child: 'orders' },
  ]).schema;

describe('AI 설계 검토', () => {
  it('같은 문제는 같은 id (대소문자·공백 차이 무시)', () => {
    expect(reviewItemId('warning', 'orders', undefined, '주문 상태가 없습니다')).toBe(reviewItemId('warning', 'ORDERS', undefined, '주문  상태가 없습니다 '));
    expect(reviewItemId('warning', 'orders', undefined, 'a')).not.toBe(reviewItemId('error', 'orders', undefined, 'a'));
  });

  it('없는 테이블·컬럼, 잘못된 등급은 거절', () => {
    const s = design();
    expect(() => buildReview(s, { items: [{ severity: 'error', table: 'nope', message: 'x' }] })).toThrow('테이블을 찾을 수 없습니다');
    expect(() => buildReview(s, { items: [{ severity: 'error', table: 'member', column: 'nope', message: 'x' }] })).toThrow('컬럼을 찾을 수 없습니다');
    expect(() => buildReview(s, { items: [{ severity: 'fatal' as never, message: 'x' }] })).toThrow('등급');
    expect(() => buildReview(s, { items: [{ severity: 'info', message: ' ' }] })).toThrow('내용');
  });

  it('검토 뒤 대상 테이블이 바뀌면 "다시 확인 필요", 위치만 옮기면 그대로, 지워지면 대상 없음', () => {
    const s = design();
    const review = buildReview(s, { items: [{ severity: 'warning', table: 'orders', message: '주문 상태 컬럼이 없습니다' }, { severity: 'info', message: '전체 의견' }] });
    const [item, general] = review.items;
    expect(reviewItemState(item!, s)).toBe('open');
    const moved = applyCommands(s, []).schema;
    moved.tables[1]!.position = { x: 999, y: 999 };
    expect(reviewItemState(item!, moved)).toBe('open');
    const changed = applyCommands(s, [{ op: 'addColumn', table: 'orders', column: { name: 'status', type: 'VARCHAR(20)' } }]).schema;
    expect(reviewItemState(item!, changed)).toBe('stale');
    // 관계가 바뀌어도 그 테이블이 바뀐 것으로 본다
    const unlinked = applyCommands(s, [{ op: 'dropRelation', parent: 'member', child: 'orders' }]).schema;
    expect(reviewItemState(item!, unlinked)).toBe('stale');
    const dropped = applyCommands(s, [{ op: 'dropTable', table: 'orders' }]).schema;
    expect(reviewItemState(item!, dropped)).toBe('missing');
    expect(reviewItemState(general!, changed)).toBe('open');
  });

  it('해결 표시, 다음 검토에서 해결 기록은 남고 다시 나오면 다시 열림', () => {
    const s = design();
    const first = buildReview(s, { items: [{ severity: 'error', table: 'orders', message: 'A' }, { severity: 'warning', table: 'orders', message: 'B' }] });
    const [a, b] = first.items;
    const { review, resolved, unknown } = resolveReviewItems(first, [a!.id, 'ai:nope'], '고침');
    expect(resolved.map((i) => i.id)).toEqual([a!.id]);
    expect(unknown).toEqual(['ai:nope']);
    expect(review.items.find((i) => i.id === a!.id)).toMatchObject({ status: 'resolved', resolution: '고침' });
    // 다음 검토: B만 다시 나옴 → B 열림, A는 해결 기록으로 남음
    const second = buildReview(s, { items: [{ severity: 'warning', table: 'orders', message: 'B' }] }, review);
    expect(second.items.map((i) => [i.id, i.status])).toEqual([[b!.id, 'open'], [a!.id, 'resolved']]);
    // A가 다시 나오면 다시 열림
    const third = buildReview(s, { items: [{ severity: 'error', table: 'orders', message: 'A' }] }, second);
    expect(third.items.find((i) => i.id === a!.id)?.status).toBe('open');
  });
});
