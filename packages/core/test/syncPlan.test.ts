import { describe, expect, it } from 'vitest';
import { applyChanges, generateStatements, getDialect, parseDdl, planPull, planPush, summarizePlan, syncedBaseline, toLink, type Schema } from '../src';

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

describe('논리명(코멘트)', () => {
  const dialects = ['mysql', 'postgresql', 'oracle', 'mssql'] as const;
  // DB에는 코멘트가 없고 ERD에만 논리명이 있는 상태에서 맞춘다
  const setup = () => {
    const db = read(BASE.replace(" COMMENT='회원'", ''));
    const erd = structuredClone(db);
    erd.tables[0].logicalName = '회원';
    erd.tables[0].columns[1].logicalName = '이메일';
    const baseline = syncedBaseline(db, erd);
    return { db, erd, baseline };
  };

  it.each(dialects)('%s: 맞춘 뒤 ERD에서 단 논리명은 "ERD에서 바뀜" — 내보내기 배지·COMMENT 문장', (id) => {
    const dialect = getDialect(id);
    const { db, erd, baseline } = setup();
    erd.tables[1].logicalName = '주문';
    erd.tables[1].columns[2].logicalName = '메모';
    const pull = planPull(erd, db, { dialect, baseline });
    expect(summarizePlan(pull)).toMatchObject({ total: 2, erd: 2, db: 0 });
    // 가져오기는 ERD 논리명을 지우지 않도록 기본 선택에서 뺀다
    expect(pull.defaultSelected.size).toBe(0);
    const push = planPush(erd, db, { dialect, baseline });
    const sql = generateStatements(push.diff, dialect, push.defaultSelected).map((s) => s.sql).join('\n');
    expect(sql).toContain('주문');
    expect(sql).toContain('메모');
  });

  it.each(dialects)('%s: 맞출 때 이미 ERD에만 있던 논리명은 차이로 보지 않는다 (DB에 코멘트 없음)', (id) => {
    const { db, erd, baseline } = setup();
    expect(planPull(erd, db, { dialect: getDialect(id), baseline }).diff.changes).toEqual([]);
    // 기준 시점이 없을 때도 (처음 맞추기 전)
    expect(planPull(erd, db, { dialect: getDialect(id) }).diff.changes).toEqual([]);
  });

  it('맞춘 뒤 DB에 생긴 컬럼은 DB에 코멘트가 없으면 ERD 논리명을 이어받는다', () => {
    const { db, erd, baseline } = setup();
    const db2 = read(BASE.replace(" COMMENT='회원'", '').replace('nick VARCHAR(30))', 'nick VARCHAR(30), phone VARCHAR(20))'));
    const erd2 = read(BASE.replace(" COMMENT='회원'", '').replace('nick VARCHAR(30))', 'nick VARCHAR(30), phone VARCHAR(20))'));
    Object.assign(erd2.tables[0], { logicalName: '회원' });
    erd2.tables[0].columns[1].logicalName = '이메일';
    erd2.tables[0].columns[3].logicalName = '전화';
    void erd;
    void db;
    const plan = planPull(erd2, db2, { dialect: pg, baseline });
    expect(plan.diff.changes).toEqual([]);
  });

  it('DB에서 코멘트를 바꾸면 "DB에서 바뀜"', () => {
    const { erd, baseline } = setup();
    const db2 = read(BASE.replace(" COMMENT='회원'", '').replace('email VARCHAR(100) NOT NULL', "email VARCHAR(100) NOT NULL COMMENT '메일 주소'"));
    const plan = planPull(erd, db2, { dialect: mysql, baseline });
    expect(summaries(plan)).toEqual(['db:member.email 변경: 코멘트']);
  });
});
