import { addColumn, addIndex, addTable, connectTables, emptySchema, type Schema } from '@erd/core';

/** 처음 써보는 사람을 위한 쇼핑몰 예제 */
export function sampleSchema(): Schema {
  const s = emptySchema();

  const member = addTable(s, { name: 'member', logicalName: '회원', position: { x: 0, y: 0 } });
  addColumn(s, member.id, { name: 'member_id', logicalName: '회원번호', type: 'BIGINT', length: '', primaryKey: true, autoIncrement: true });
  addColumn(s, member.id, { name: 'email', logicalName: '이메일', type: 'VARCHAR', length: '100', nullable: false, unique: true });
  addColumn(s, member.id, { name: 'name', logicalName: '이름', type: 'VARCHAR', length: '50', nullable: false });
  addColumn(s, member.id, { name: 'created_at', logicalName: '가입일시', type: 'DATETIME', length: '', nullable: false, defaultValue: 'CURRENT_TIMESTAMP' });

  const product = addTable(s, { name: 'product', logicalName: '상품', position: { x: 0, y: 320 }, color: '#059669' });
  addColumn(s, product.id, { name: 'product_id', logicalName: '상품번호', type: 'BIGINT', length: '', primaryKey: true, autoIncrement: true });
  const productName = addColumn(s, product.id, { name: 'name', logicalName: '상품명', type: 'VARCHAR', length: '200', nullable: false });
  addColumn(s, product.id, { name: 'price', logicalName: '가격', type: 'DECIMAL', length: '12,2', nullable: false, defaultValue: '0' });
  addIndex(s, product.id, { columnIds: [productName.id] });

  const orders = addTable(s, { name: 'orders', logicalName: '주문', position: { x: 420, y: 0 }, color: '#ea580c' });
  addColumn(s, orders.id, { name: 'order_id', logicalName: '주문번호', type: 'BIGINT', length: '', primaryKey: true, autoIncrement: true });
  const status = addColumn(s, orders.id, { name: 'status', logicalName: '주문상태', type: 'VARCHAR', length: '20', nullable: false, defaultValue: "'READY'" });
  const ordered = addColumn(s, orders.id, { name: 'ordered_at', logicalName: '주문일시', type: 'DATETIME', length: '', nullable: false });
  connectTables(s, { parentTableId: member.id, childTableId: orders.id });
  const memberFk = orders.columns.find((c) => c.name === 'member_id')!;
  addIndex(s, orders.id, { name: 'ix_orders_member_date', columnIds: [memberFk.id, ordered.id] });
  addIndex(s, orders.id, { columnIds: [status.id] });

  const item = addTable(s, { name: 'order_item', logicalName: '주문상품', position: { x: 420, y: 320 }, color: '#ea580c' });
  connectTables(s, { parentTableId: orders.id, childTableId: item.id, identifying: true, onDelete: 'CASCADE' });
  connectTables(s, { parentTableId: product.id, childTableId: item.id, identifying: true });
  addColumn(s, item.id, { name: 'quantity', logicalName: '수량', type: 'INT', length: '', nullable: false, defaultValue: '1' });

  return s;
}
