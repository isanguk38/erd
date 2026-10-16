import { describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, similarColor, type Schema } from '../src';

const tables = (): Schema =>
  applyCommands(emptySchema(), ['member', 'orders', 'order_item', 'payment', 'coupon'].map((name) => ({ op: 'createTable' as const, name, columns: [{ name: `${name}_id`, type: 'BIGINT', primaryKey: true }] }))).schema;
const colorOf = (s: Schema, name: string) => s.tables.find((t) => t.name === name)!.color;

describe('AI 영역 만들기: 영역 색 = 테이블 색', () => {
  it('createArea·addToArea: 영역 색으로 테이블을 칠하고, 공통 테이블은 먼저 들어간 영역 색을 지킨다', () => {
    const { schema, messages } = applyCommands(tables(), [
      { op: 'createArea', name: '회원', tables: ['member'], color: '#2563eb' },
      { op: 'createArea', name: '주문', tables: ['orders', 'order_item', 'member'], color: '#059669' },
      { op: 'addToArea', area: '주문', tables: ['payment'] },
    ]);
    expect(colorOf(schema, 'member')).toBe('#2563eb');
    expect(colorOf(schema, 'orders')).toBe('#059669');
    expect(colorOf(schema, 'order_item')).toBe('#059669');
    expect(colorOf(schema, 'payment')).toBe('#059669');
    expect(colorOf(schema, 'coupon')).toBeUndefined();
    expect(messages[1]).toContain('색 #059669, 테이블 3개, 테이블 2개를 영역 색으로');
  });

  it('색을 주지 않으면 차례로 주는 영역 색으로 칠한다', () => {
    const { schema } = applyCommands(tables(), [{ op: 'createArea', name: '쿠폰', tables: ['coupon'] }]);
    expect(colorOf(schema, 'coupon')).toBe(schema.areas![0]!.color);
    expect(colorOf(schema, 'coupon')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('colorTables=false면 테이블 색은 그대로', () => {
    const { schema } = applyCommands(tables(), [{ op: 'createArea', name: '주문', tables: ['orders'], color: '#059669', colorTables: false }]);
    expect(colorOf(schema, 'orders')).toBeUndefined();
  });

  it('영역 색을 바꾸면 그 색을 따르던 테이블도 바뀌고, 따로 정한 색은 그대로', () => {
    let { schema } = applyCommands(tables(), [{ op: 'createArea', name: '주문', tables: ['orders', 'payment'], color: '#059669' }]);
    schema = applyCommands(schema, [{ op: 'updateTable', table: 'payment', color: '#dc2626' }]).schema;
    schema = applyCommands(schema, [{ op: 'updateArea', area: '주문', color: '#ea580c' }]).schema;
    expect(colorOf(schema, 'orders')).toBe('#ea580c');
    expect(colorOf(schema, 'payment')).toBe('#dc2626');
  });

  it('createTable(area): 영역 색, 색을 직접 주면 그 색', () => {
    let { schema } = applyCommands(tables(), [{ op: 'createArea', name: '주문', tables: ['orders'], color: '#059669' }]);
    schema = applyCommands(schema, [
      { op: 'createTable', name: 'refund', area: '주문', columns: [{ name: 'refund_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'memo', area: '주문', color: '#9333ea', columns: [{ name: 'memo_id', type: 'BIGINT', primaryKey: true }] },
    ]).schema;
    expect(colorOf(schema, 'refund')).toBe('#059669');
    expect(colorOf(schema, 'memo')).toBe('#9333ea');
  });

  it('이미 있는 영역: updateArea(colorTables=true)로 테이블을 모두 영역 색으로 (공통 테이블은 첫 영역 색)', () => {
    // 사람이 화면에서 만든 영역처럼 테이블 색은 칠하지 않고 만든다
    let { schema } = applyCommands(tables(), [
      { op: 'createArea', name: '회원', tables: ['member'], color: '#2563eb', colorTables: false },
      { op: 'createArea', name: '주문', tables: ['orders', 'member'], color: '#059669', colorTables: false },
      { op: 'updateTable', table: 'orders', color: '#dc2626' },
    ]);
    expect(colorOf(schema, 'member')).toBeUndefined();
    const r = applyCommands(schema, [
      { op: 'updateArea', area: '주문', colorTables: true },
      { op: 'updateArea', area: '회원', colorTables: true },
    ]);
    schema = r.schema;
    expect(colorOf(schema, 'orders')).toBe('#059669');
    expect(colorOf(schema, 'member')).toBe('#2563eb');
    expect(r.messages[0]).toContain('테이블 1개 색을 #059669로');
  });

  it('영역 색은 서로 겹치지 않는다: 자동 색은 안 쓰인 색, 같거나 비슷한 색을 주면 바꾸고 알림', () => {
    // 자동 색: 12개 영역이 모두 서로 구분되는 색 (비슷한 색도 아님)
    const many = applyCommands(emptySchema(), Array.from({ length: 12 }, (_, i) => ({ op: 'createArea' as const, name: `영역${i}` }))).schema;
    const colors = many.areas!.map((a) => a.color!);
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) expect(similarColor(colors[i]!, colors[j]!), `${colors[i]} ${colors[j]}`).toBe(false);

    // 지운 영역 자리를 차례 번호로 채우다 겹치지 않는다
    let s = applyCommands(emptySchema(), [{ op: 'createArea', name: 'A' }, { op: 'createArea', name: 'B' }, { op: 'dropArea', area: 'A' }, { op: 'createArea', name: 'C' }]).schema;
    expect(s.areas![0]!.color).not.toBe(s.areas![1]!.color);

    // AI가 같은 색·비슷한 색을 주면 겹치지 않는 색으로
    const r = applyCommands(tables(), [
      { op: 'createArea', name: '회원', tables: ['member'], color: '#2563eb' },
      { op: 'createArea', name: '주문', tables: ['orders'], color: '#2563eb' },
      { op: 'createArea', name: '결제', tables: ['payment'], color: '#2a60e8' },
    ]);
    const [a, b, c] = r.schema.areas!.map((x) => x.color!);
    expect(a).toBe('#2563eb');
    expect(similarColor(a!, b!) || similarColor(a!, c!) || similarColor(b!, c!)).toBe(false);
    expect(r.messages[1]).toContain('영역 회원과(와) 겹쳐');
    expect(colorOf(r.schema, 'orders')).toBe(b); // 테이블도 바뀐 색으로
    // updateArea도 같은 규칙 (자기 자신 색은 겹침이 아님)
    s = applyCommands(r.schema, [{ op: 'updateArea', area: '주문', color: '#2563eb' }, { op: 'updateArea', area: '회원', color: '#2563eb' }]).schema;
    expect(s.areas!.find((x) => x.name === '주문')!.color).not.toBe('#2563eb');
    expect(s.areas!.find((x) => x.name === '회원')!.color).toBe('#2563eb');
  });

  it('moveToArea: 옮긴 영역 색으로', () => {
    let { schema } = applyCommands(tables(), [
      { op: 'createArea', name: '주문', tables: ['orders', 'payment'], color: '#059669' },
      { op: 'createArea', name: '결제', color: '#9333ea' },
    ]);
    schema = applyCommands(schema, [{ op: 'moveToArea', area: '결제', tables: ['payment'] }]).schema;
    expect(colorOf(schema, 'payment')).toBe('#9333ea');
  });
});
