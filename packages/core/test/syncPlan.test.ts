import { describe, expect, it } from 'vitest';
import { applyChanges, generateStatements, getDialect, parseDdl, planPull, planPush, toLink, type Schema } from '../src';

const mysql = getDialect('mysql');
const pg = getDialect('postgresql');

const BASE = `
CREATE TABLE member (member_id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) NOT NULL, nick VARCHAR(30)) COMMENT='회원';
CREATE TABLE orders (order_id BIGINT NOT NULL PRIMARY KEY, member_id BIGINT NOT NULL, memo TEXT,
  CONSTRAINT fk_orders_member FOREIGN KEY (member_id) REFERENCES member (member_id));
`;
const read = (sql: string): Schema => parseDdl(sql, { dialect: 'mysql' }).schema;
const summaries = (plan: ReturnType<typeof planPush>) => plan.diff.changes.map((c) => `${plan.origins[c.id]}:${c.summary}`);

describe('이름 변경 추정', () => {
  it('ERD에서 컬럼 이름을 바꾸면 삭제+추가 대신 이름 변경을 제안하고, 받아들이면 RENAME이 된다', () => {
    const db = read(BASE);
    const erd = read(BASE.replace('nick VARCHAR(30)', 'nickname VARCHAR(30)'));
    const plan = planPush(erd, db, { dialect: mysql });
    expect(plan.diff.changes.map((c) => c.summary)).toEqual(['member.nickname 컬럼 추가', 'member.nick 컬럼 삭제']);
    expect(plan.renames).toMatchObject([{ kind: 'column', tableName: 'member', dbName: 'nick', erdName: 'nickname' }]);

    const accepted = planPush(erd, db, { dialect: mysql, links: [toLink(plan.renames[0])] });
    const sql = generateStatements(accepted.diff, mysql, accepted.defaultSelected).map((s) => s.sql);
    expect(sql).toEqual(['ALTER TABLE `member` CHANGE COLUMN `nick` `nickname` VARCHAR(30) NULL']);
  });

  it('모양(타입·NULL)이 다르면 제안하지 않는다', () => {
    const db = read(BASE);
    const erd = read(BASE.replace('nick VARCHAR(30)', 'nickname VARCHAR(50)'));
    expect(planPush(erd, db, { dialect: mysql }).renames).toEqual([]);
  });

  it('DB에서 컬럼 이름을 바꾼 것을 가져오면 ERD 컬럼의 id·논리명을 유지한 채 이름만 바뀐다', () => {
    const erd = read(BASE);
    erd.tables[0].columns[2].logicalName = '별명';
    const db = read(BASE.replace('nick VARCHAR(30)', 'nickname VARCHAR(30)'));
    const plan = planPull(erd, db, { dialect: mysql });
    expect(plan.renames).toHaveLength(1);
    const accepted = planPull(erd, db, { dialect: mysql, links: [toLink(plan.renames[0])] });
    expect(accepted.diff.changes.map((c) => c.summary)).toEqual(['member.nickname 변경: 이름 nick → nickname']);
    const next = applyChanges(erd, accepted.diff, accepted.defaultSelected);
    expect(next.tables[0].columns[2]).toMatchObject({ id: erd.tables[0].columns[2].id, name: 'nickname', logicalName: '별명' });
  });

  it('테이블 이름 변경도 제안한다', () => {
    const db = read(BASE);
    const erd = read(BASE.replace('CREATE TABLE orders', 'CREATE TABLE purchase').replace('fk_orders_member', 'fk_purchase_member'));
    const plan = planPush(erd, db, { dialect: pg });
    const table = plan.renames.find((r) => r.kind === 'table')!;
    expect(table).toMatchObject({ dbName: 'orders', erdName: 'purchase' });
    const accepted = planPush(erd, db, { dialect: pg, links: [toLink(table)] });
    const sql = generateStatements(accepted.diff, pg, accepted.defaultSelected).map((s) => s.sql);
    expect(sql[0]).toBe('ALTER TABLE orders DROP CONSTRAINT fk_orders_member');
    expect(sql).toContain('ALTER TABLE orders RENAME TO purchase');
    expect(sql.some((s) => s.startsWith('CREATE TABLE'))).toBe(false);
    // 테이블 안의 컬럼은 같은 것으로 맞춰져 삭제·추가가 생기지 않는다
    expect(sql.some((s) => s.includes('DROP COLUMN') || s.includes('ADD COLUMN'))).toBe(false);
  });
});

describe('3방향 비교', () => {
  // 기준: 마지막으로 맞춘 시점의 DB
  const setup = () => {
    const baseline = read(BASE);
    const erd = structuredClone(baseline);
    const dbSql = BASE.replace('memo TEXT', 'memo TEXT, status VARCHAR(20)'); // 누군가 DB에 status 추가
    erd.tables[0].columns.push({ ...erd.tables[0].columns[2], id: 'col_grade', name: 'grade' }); // ERD에서 grade 설계
    return { baseline, erd, db: read(dbSql) };
  };

  it('내보내기: ERD에서 바뀐 것만 기본 선택하고, DB에서 바뀐 것은 되돌리지 않는다', () => {
    const { baseline, erd, db } = setup();
    const plan = planPush(erd, db, { dialect: mysql, baseline });
    expect(summaries(plan)).toEqual(['erd:member.grade 컬럼 추가', 'db:orders.status 컬럼 삭제']);
    const sql = generateStatements(plan.diff, mysql, plan.defaultSelected).map((s) => s.sql);
    expect(sql).toEqual(['ALTER TABLE `member` ADD COLUMN `grade` VARCHAR(30) NULL AFTER `nick`']);
  });

  it('가져오기: DB에서 바뀐 것만 기본 선택하고, 아직 DB에 안 넣은 ERD 설계는 지우지 않는다', () => {
    const { baseline, erd, db } = setup();
    const plan = planPull(erd, db, { dialect: mysql, baseline });
    expect(summaries(plan).sort()).toEqual(['db:orders.status 컬럼 추가', 'erd:member.grade 컬럼 삭제']);
    const next = applyChanges(erd, plan.diff, plan.defaultSelected);
    expect(next.tables[0].columns.map((c) => c.name)).toContain('grade');
    expect(next.tables[1].columns.map((c) => c.name)).toContain('status');
  });

  it('같은 컬럼을 양쪽에서 고치면 충돌로 표시하고 기본 선택하지 않는다', () => {
    const baseline = read(BASE);
    const erd = read(BASE.replace('email VARCHAR(100)', 'email VARCHAR(200)'));
    const db = read(BASE.replace('email VARCHAR(100)', 'email VARCHAR(150)'));
    const plan = planPush(erd, db, { dialect: mysql, baseline });
    expect(summaries(plan)).toEqual(['conflict:member.email 변경: 타입 VARCHAR(150) → VARCHAR(200)']);
    expect(plan.defaultSelected.size).toBe(0);
  });

  it('기준 시점이 없으면 알 수 없음으로 두고 예전처럼 동작한다', () => {
    const { erd, db } = setup();
    const plan = planPush(erd, db, { dialect: mysql });
    expect(plan.hasBaseline).toBe(false);
    expect(Object.values(plan.origins)).toEqual(['unknown', 'unknown']);
  });
});
