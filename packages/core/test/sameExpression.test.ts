import { describe, expect, it } from 'vitest';
import { sameExpression } from '../src';

// sameExpression은 DB와 상관없는 글자 차이(대소문자·공백·따옴표·괄호)만 무시한다.
// DB가 식을 자기 표기로 바꿔 저장한 것은 여기서 맞추지 않고, DB와 맞출 때 기억한 식 짝으로 맞춘다 (expressionMemory.test.ts).
describe('sameExpression', () => {
  it('대소문자·공백·따옴표·괄호 차이는 같은 식', () => {
    expect(sameExpression('lower(email)', '(LOWER( "email" ))')).toBe(true);
    expect(sameExpression('`point` >= 0', '(point >= 0)')).toBe(true);
  });

  it('값이 다르면 다른 식', () => {
    expect(sameExpression('point >= 0', 'point >= 1')).toBe(false);
  });

  it('DB가 바꿔 쓴 모양은 DB별 규칙으로 맞추지 않는다 (식 짝으로 맞춤)', () => {
    expect(sameExpression("status IN ('A', 'B')", "((status)::text = ANY ((ARRAY['A'::character varying, 'B'::character varying])::text[]))")).toBe(false);
    expect(sameExpression('vlt BETWEEN 0 AND 100', '((vlt >= 0) AND (vlt <= 100))')).toBe(false);
  });
});
