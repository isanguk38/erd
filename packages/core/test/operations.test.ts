import { describe, expect, it } from 'vitest';
import { applyCommands, emptySchema, type Schema } from '../src';

const run = (cmds: Parameters<typeof applyCommands>[1]) => applyCommands(emptySchema(), cmds).schema;
const table = (s: Schema, name: string) => s.tables.find((t) => t.name === name)!;
const fkColumns = (s: Schema, child: string) =>
  s.relations.filter((r) => r.fromTableId === table(s, child).id).map((r) => r.fromColumnIds.map((id) => table(s, child).columns.find((c) => c.id === id)!.name));

describe('관계를 만들 때 FK 컬럼 이름', () => {
  it('부모 기본키가 "id"면 자식의 id를 쓰지 않고 테이블 이름을 붙인다 (camelCase 스키마)', () => {
    const s = run([
      { op: 'createTable', name: 'products', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'createdAt', type: 'TIMESTAMP' }] },
      { op: 'createTable', name: 'categories', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'product_reviews', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'products', child: 'product_reviews' },
      { op: 'addRelation', parent: 'categories', child: 'products' },
      { op: 'addRelation', parent: 'product_reviews', child: 'product_reviews' },
    ]);
    expect(fkColumns(s, 'product_reviews')).toEqual([['productId'], ['parentId']]);
    expect(fkColumns(s, 'products')).toEqual([['categoryId']]);
    // 자식의 기본키 id는 그대로
    expect(table(s, 'product_reviews').columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual(['id']);
  });

  it('snake_case 스키마면 product_id, 기본키에 이름이 있으면 그대로 쓴다', () => {
    const s = run([
      { op: 'createTable', name: 'addresses', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'member', columns: [{ name: 'member_id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'orders', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }, { name: 'member_id', type: 'BIGINT' }] },
      { op: 'addRelation', parent: 'addresses', child: 'orders' },
      { op: 'addRelation', parent: 'member', child: 'orders' },
    ]);
    expect(fkColumns(s, 'orders')).toEqual([['address_id'], ['member_id']]);
    // 같은 이름 컬럼이 이미 있으면 새로 만들지 않고 그 컬럼을 쓴다
    expect(table(s, 'orders').columns.map((c) => c.name)).toEqual(['id', 'member_id', 'address_id']);
  });

  it('N:M 연결 테이블도 id끼리 겹치지 않는다', () => {
    const s = run([
      { op: 'createTable', name: 'tags', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'createTable', name: 'posts', columns: [{ name: 'id', type: 'BIGINT', primaryKey: true }] },
      { op: 'addRelation', parent: 'tags', child: 'posts', cardinality: 'N:M' },
    ]);
    expect(table(s, 'tags_posts').columns.map((c) => c.name)).toEqual(['tag_id', 'post_id']);
  });
});
