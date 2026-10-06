import { describe, expect, it } from 'vitest';
import { sameExpression } from '../src';

// DB가 저장하면서 바꿔 쓰는 식을 ERD에 적은 식과 같다고 보는지 (다르면 DB와 맞춘 뒤에도 계속 "바뀜"으로 나온다)
describe('sameExpression', () => {
  it('PostgreSQL: BETWEEN을 >= AND <=로 풀어 쓴 것', () => {
    expect(sameExpression('vlt BETWEEN 0 AND 100', '((vlt >= 0) AND (vlt <= 100))')).toBe(true);
    expect(sameExpression('vlt BETWEEN 0 AND 100', '((vlt >= 0) AND (vlt <= 99))')).toBe(false);
  });

  it('PostgreSQL: IN 목록을 = ANY (ARRAY[...])로 바꿔 쓴 것', () => {
    expect(sameExpression("status IN ('REQUESTED', 'CONFIRMED')", "((status)::text = ANY ((ARRAY['REQUESTED'::character varying, 'CONFIRMED'::character varying])::text[]))")).toBe(true);
    expect(sameExpression("phase IN ('BEFORE', 'AFTER')", "((phase)::text = ANY ((ARRAY['BEFORE'::character varying, 'AFTER'::character varying])::text[]))")).toBe(true);
    expect(sameExpression('grade IN (1, 2)', '(grade = ANY (ARRAY[1, 2]))')).toBe(true);
    expect(sameExpression("status NOT IN ('X')", "((status)::text <> ALL ((ARRAY['X'::character varying])::text[]))")).toBe(true);
    expect(sameExpression("status IN ('A', 'B')", "((status)::text = ANY ((ARRAY['A'::character varying, 'C'::character varying])::text[]))")).toBe(false);
  });

  it('조건이 섞인 CHECK', () => {
    expect(
      sameExpression(
        "discount_type IN ('AMOUNT','RATE') AND valid_to > valid_from",
        "(((discount_type)::text = ANY ((ARRAY['AMOUNT'::character varying, 'RATE'::character varying])::text[])) AND (valid_to > valid_from))",
      ),
    ).toBe(true);
  });
});
