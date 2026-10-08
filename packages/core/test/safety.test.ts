import { describe, expect, it } from 'vitest';
import { getDialect, safetyFindings, safetySql, SAFETY_CAP, type SafetyCheck } from '../src';

const dup: SafetyCheck = { id: 'a', changeId: 'addIndex:t:i', table: 'member', kind: 'duplicates', columns: ['email'] };
const long: SafetyCheck = { id: 'b', changeId: 'alterColumn:t:c', table: 'member', kind: 'tooLong', column: 'nick', length: 5 };

describe('안전 검사 SQL', () => {
  it('DB 종류마다 건수를 SAFETY_CAP+1에서 멈추고, 이름은 그 DB 방식으로 감싼다', () => {
    expect(safetySql(getDialect('mysql'), long)).toBe(`SELECT COUNT(*) AS n FROM (SELECT 1 AS x FROM \`member\` WHERE CHAR_LENGTH(\`nick\`) > 5 LIMIT ${SAFETY_CAP + 1}) t`);
    expect(safetySql(getDialect('oracle'), long)).toContain(`ROWNUM <= ${SAFETY_CAP + 1}`);
    expect(safetySql(getDialect('mssql'), long)).toContain(`TOP ${SAFETY_CAP + 1}`);
    expect(safetySql(getDialect('mssql'), long)).toContain('LEN([nick])');
    expect(safetySql(getDialect('postgresql'), dup)).toContain('GROUP BY email HAVING COUNT(*) > 1');
  });

  it('CHECK 식에 ;가 있으면 만들지 않는다', () => {
    expect(() => safetySql(getDialect('postgresql'), { id: 'c', changeId: 'x', table: 't', kind: 'check', expression: '1=1; DROP TABLE t' })).toThrow();
  });

  it('건수가 0이면 안내하지 않고, 상한을 넘으면 "이상"으로', () => {
    const f = safetyFindings([dup, long], [{ id: 'a', count: SAFETY_CAP + 1 }, { id: 'b', count: 0 }]);
    expect([...f.keys()]).toEqual(['addIndex:t:i']);
    expect(f.get('addIndex:t:i')![0].text).toContain('1,000묶음 이상');
  });
});
