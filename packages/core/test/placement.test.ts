import { describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, estimateTableSize, type Table } from '../src';

const box = (t: Table) => ({ ...t.position, ...estimateTableSize(t) });
const overlap = (a: Table, b: Table) => {
  const x = box(a), y = box(b);
  return x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
};

describe('새 테이블 배치', () => {
  it('관계가 있으면 그 테이블 옆에, 다른 테이블과 겹치지 않게 놓는다', () => {
    let s = applyCommands(emptySchema(), [
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'product', columns: [{ name: 'product_id', type: 'BIGINT', primaryKey: true }] },
    ]).schema;
    s.tables[0].position = { x: 0, y: 0 };
    s.tables[1].position = { x: 0, y: 2000 };
    s = applyCommands(s, [
      { op: 'createTable', name: 'coupon', columns: [{ name: 'coupon_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'member', child: 'coupon' },
      { op: 'createTable', name: 'coupon_use', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'coupon', child: 'coupon_use' },
      { op: 'createTable', name: 'memo', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
    ]).schema;
    const [member, product, coupon, couponUse, memo] = s.tables;
    // coupon은 member 바로 오른쪽, coupon_use는 coupon 근처
    expect(coupon.position.y).toBe(member.position.y);
    expect(coupon.position.x).toBeGreaterThan(member.position.x);
    expect(coupon.position.x).toBeLessThan(800);
    expect(Math.abs(couponUse.position.x - coupon.position.x) + Math.abs(couponUse.position.y - coupon.position.y)).toBeLessThan(800);
    // 관계 없는 memo는 아래쪽
    expect(memo.position.y).toBeGreaterThan(product.position.y);
    for (let i = 0; i < s.tables.length; i++) for (let j = i + 1; j < s.tables.length; j++) expect(overlap(s.tables[i], s.tables[j])).toBe(false);
  });
});
