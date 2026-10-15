import { describe, expect, it } from 'vitest';
import { diagnoseDbError } from '../src';

describe('DB 오류 진단', () => {
  it('접속 오류: 원인과 누가 고칠지', () => {
    expect(diagnoseDbError('connect ECONNREFUSED 127.0.0.1:5432', 'connect')).toMatchObject({ actor: 'either', cause: expect.stringContaining('연결할 수 없습니다') });
    expect(diagnoseDbError('password authentication failed for user "postgres"', 'connect')?.actor).toBe('user');
    expect(diagnoseDbError("Access denied for user 'root'@'localhost' (using password: YES)", 'connect')?.actor).toBe('user');
    expect(diagnoseDbError('database "game" does not exist', 'connect')?.cause).toContain('game');
    expect(diagnoseDbError("Unknown database 'shop'", 'connect')?.cause).toContain('shop');
    expect(diagnoseDbError('getaddrinfo ENOTFOUND db.example', 'connect')?.cause).toContain('호스트');
    expect(diagnoseDbError('connect ETIMEDOUT 10.0.0.5:3306', 'connect')?.actor).toBe('user');
    expect(diagnoseDbError('The server does not support SSL connections', 'connect')?.cause).toContain('SSL');
  });

  it('실행 오류: AI가 ERD로 고칠 것과 사람이 할 것', () => {
    expect(diagnoseDbError('"gin_trgm_ops" 연산자 클래스는 "gin" 인덱스 액세스 방법에서 사용할 수 없습니다', 'execute')?.cause).toContain('gin_trgm_ops');
    expect(diagnoseDbError('operator class "gin_trgm_ops" does not exist for access method "gin"', 'execute')?.fix).toContain('pg_trgm');
    expect(diagnoseDbError('constraint "fk_a_b" for relation "a" already exists', 'execute')).toMatchObject({ actor: 'ai', cause: expect.stringContaining('fk_a_b') });
    expect(diagnoseDbError('"fk_liar_accusation_hand_player" 제약 조건이 이미 "liar_accusation" 릴레이션(relation)에서 사용되고 있습니다', 'execute')?.actor).toBe('ai');
    expect(diagnoseDbError('column "status" cannot be cast automatically to type interrogation_status', 'execute')?.cause).toContain('타입');
    expect(diagnoseDbError('invalid input value for enum "INTERROGATION_STATUS": "X"', 'execute')?.fix).toContain('ENUM');
    expect(diagnoseDbError('column "email" of relation "member" contains null values', 'execute')?.cause).toContain('NULL');
    expect(diagnoseDbError("Duplicate entry 'a@x.com' for key 'ux_email'", 'execute')?.cause).toContain('같은 값');
    expect(diagnoseDbError('완전히 처음 보는 오류', 'execute')).toBe(null);
  });
});
