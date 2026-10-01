# ERD 협업 도구 기능 설계

## 1. 한 줄 요약

모든 기능이 **하나의 스키마 모델**과 **하나의 비교 엔진(diff)** 을 공유한다.
화면 편집, SQL 붙여넣기, 외부 DB 읽기, AI(MCP)가 모두 같은 모델을 바꾸고,
CREATE/ALTER SQL, DB 바로 적용, 테이블 정의서, 버전 비교가 모두 같은 비교 엔진으로 만들어진다.

```
 입력                         스키마 모델                       출력
 화면 편집 ─────┐   ┌───────────────────────────────┐   ┌──▶ CREATE / ALTER / INDEX SQL
 SQL 붙여넣기 ──┼──▶│ 테이블·컬럼·인덱스·관계         │───┼──▶ DB에 바로 적용
 외부 DB 읽기 ──┤   │ 논리명/물리명, 모든 요소에 고유 ID │   ├──▶ 테이블 정의서 (Excel)
 AI (MCP) ─────┘   └──────────────┬────────────────┘   └──▶ PNG / SVG
                                  │
                        비교 엔진 diff(A, B) → 변경 목록
              (버전 비교, DB 갱신, DB 적용, AI 제안 미리보기에서 모두 사용)
```

## 2. 스키마 모델

| 요소 | 속성 |
|---|---|
| Table | id, name(물리명), logicalName(논리명), comment, columns[], indexes[], position, color |
| Column | id, name, logicalName, type, length, nullable, primaryKey, unique, autoIncrement, defaultValue, comment |
| Index | id, name, columnIds[], unique |
| Relation | id, 자식 테이블/컬럼(FK), 부모 테이블/컬럼, 1:1·1:N, onDelete, onUpdate |

- 모든 요소에 고유 ID가 있다. 이름을 바꿔도 ID가 유지되므로 비교 시
  "삭제 후 추가"가 아니라 `RENAME`으로 정확히 잡힌다.
- 외부 DB에서 읽은 스키마는 ID가 없으므로, 이름으로 ERD와 맞춰 ID를 붙인 뒤(`alignIds`) 비교한다.
- N:M 관계는 연결 테이블을 자동으로 만들어 1:N 두 개로 표현한다.

## 3. DB 종류 확장 구조

MySQL, PostgreSQL로 시작하고, 나중에 Oracle, SQL Server 등을 추가할 수 있게 DB별 코드를 한곳에 모은다.

| 계층 | 위치 | DB별로 구현할 것 |
|---|---|---|
| SQL 방언(Dialect) | `packages/core/src/dialects/*` | 이름 감싸기, 타입 변환, CREATE/ALTER/INDEX/FK 문법, 코멘트 문법 |
| DB 연결(Connector) | `packages/db/src/connectors/*` | 접속, 스키마 읽기(information_schema), SQL 실행(트랜잭션) |
| SQL 읽기(Parser) | `packages/core/src/import/*` | DDL → 스키마 모델 |

새 DB를 추가할 때는 위 세 파일을 만들고 레지스트리에 등록하면 끝나도록 한다.
화면, 비교 엔진, 정의서, MCP 코드는 바꾸지 않는다.

## 4. 기능

### F1. 편집기
- 테이블·컬럼 편집, 관계선(1:1, 1:N, N:M), **인덱스 편집**(이름, 컬럼, UNIQUE)
- 논리명 / 물리명 / 둘 다 보기 전환

### F2. SQL 추출

| 모드 | 내용 |
|---|---|
| 전체 | 모든 테이블의 CREATE TABLE + 인덱스 + FK |
| 변경분만 | 기준 버전(또는 연결된 DB)과 비교해 바뀐 것만. **CREATE(새 테이블)** 와 **ALTER(기존 테이블 수정)**, **DROP(삭제)** 을 나눠서 보여준다 |

- 변경이 없는 테이블에 대한 SQL은 절대 만들지 않는다.
- 위험한 변경에는 경고를 단다: 컬럼/테이블 삭제, 타입 축소, 기본값 없는 NOT NULL 추가.
- 실행 순서: FK 삭제 → 인덱스 삭제 → 테이블 이름 변경 → 테이블 생성 → 컬럼 변경 → 인덱스 생성 → FK 추가 → 테이블 삭제

### F3. DDL 해석 (화면 기능 아님)
- 화면의 "SQL 붙여넣기"는 빼고 DB 직접 연결(F6)로 대신한다.
- DDL 파서는 core에 남겨 MCP의 import_ddl 도구와 테스트에서 쓴다.

### F4. 버전 이력
- 직접 저장 + 자동 저장(DB 갱신·DB 적용·AI 작업 직전)
- 두 버전 비교 화면(추가/변경/삭제 색상 표시), 비교 결과로 ALTER SQL 생성

### F5. 테이블 정의서 Excel
- 표지, 테이블 목록, 테이블별 시트(컬럼 + 인덱스 + FK), 변경 이력(선택)

### F6. 외부 DB 연동 (핵심 차별점)

**DB → ERD 갱신**
1. DB 연결 등록 (MySQL, PostgreSQL)
2. [DB에서 갱신] → DB 스키마 읽기 → 지금 ERD와 비교 → 변경 미리보기
3. 항목별로 골라 적용 → 접속한 모든 사람 화면에 반영
- ERD에만 있는 정보(위치, 색상, 논리명, 메모)는 유지한다.
- 3방향 비교: 마지막 동기화 시점 / 지금 ERD / 지금 DB
  - DB만 바뀜 → 반영 후보, ERD만 바뀜 → "DB에 아직 적용 안 됨", 둘 다 → 충돌
- 이름 변경 추정: 삭제+추가 쌍이 타입·속성이 같으면 "이름 변경인가요?" 확인

**ERD → DB 바로 적용**
1. [DB에 적용] → DB 스키마 읽기 → ERD와 비교 → 실행할 SQL 미리보기 (CREATE / ALTER / INDEX / DROP 구분)
2. 항목별로 골라 실행. DROP은 기본으로 꺼져 있고, 켜려면 테이블 이름을 직접 입력해야 한다.
3. 실행 전 자동 버전 저장, 실행 결과(성공/실패 문장) 기록
- 비교 결과에 없는 테이블은 건드리지 않는다.
- PostgreSQL은 트랜잭션으로 묶어 실패하면 전부 되돌린다. MySQL은 DDL이 자동 커밋되므로 문장 단위로 실행하고 어디까지 성공했는지 보여준다.

**연결 방식**
- 브라우저는 DB에 직접 붙을 수 없으므로 `apps/server`가 연결을 맡는다.
- 이 서버는 기본으로 내 PC(127.0.0.1)에서 실행되므로 localhost·사내망 DB에도 붙을 수 있다 (= 로컬 에이전트).
- 접속 정보는 `apps/server/data/connections.json`에 비밀번호를 AES-256-GCM으로 암호화해 저장한다.
- 실행한 SQL은 `apps/server/data/apply-log.jsonl`에 기록한다.
- 외부에 배포할 때는 로그인과 권한 확인을 붙인 뒤에만 연다.

**보안**: 접속 정보는 AES-256-GCM으로 암호화 저장, 다시 보여주지 않음.
읽기(갱신)는 메타데이터 조회만 한다. 적용은 사용자가 확인한 문장만 실행한다.

### F7. MCP (AI가 ERD 작업)

| 방식 | 사용처 |
|---|---|
| 원격 MCP (Streamable HTTP) | Claude 등의 커넥터. 개인 액세스 토큰 |
| 로컬 MCP (stdio, `npx`) | Claude Code, Cursor 등. 로컬 DB 접근 가능 |

**도구**
| 분류 | 도구 |
|---|---|
| 조회 | list_projects, get_schema, get_table |
| 편집 | create_table, update_table, drop_table, add_column, update_column, drop_column, add_index, drop_index, add_relation, drop_relation, apply_changes |
| 변환 | import_ddl, export_sql, auto_layout |
| 이력 | save_version, list_versions, diff_versions |
| DB | db_pull_preview, db_pull_apply, db_push_preview, db_push_apply |
| 문서 | export_definition_excel |
| 제안 | list_proposals, (편집 도구들의 mode 인자) |

**AI 변경 방식 (둘 다 지원, 프로젝트·토큰별로 기본값 설정)**
- 바로 적용: AI가 실시간 참가자로 문서를 바꾼다. 작업 직전 자동 버전 저장, 이력에 "AI 변경" 표시, [AI 변경 되돌리기]로 한 번에 복구.
- 제안 모드: AI 변경을 별도 제안(Proposal)으로 저장한다. 사람이 미리보기(F6과 같은 비교 화면)에서 항목별로 승인/거절한다.

## 5. 기술 구성

| 영역 | 기술 |
|---|---|
| 구조 | npm workspaces 모노레포 |
| 공통 | `packages/core`: 모델, 비교, SQL 생성/해석, 정의서 — 화면·서버·MCP가 함께 사용 |
| DB 연결 | `packages/db`: mysql2, pg |
| 화면 | `apps/web`: React + TypeScript + Vite, React Flow, Zustand |
| 동시 편집 | Yjs + WebSocket |
| 서버 | `apps/server`: Node.js + TypeScript, PostgreSQL 저장 |
| MCP | `packages/mcp`: @modelcontextprotocol/sdk |
| 엑셀 | exceljs, 배치: elkjs |

## 6. 구현 상태 (2026-10-01)

| 항목 | 상태 |
|---|---|
| 편집기, 인덱스, 논리/물리명, 자동 배치, PNG/SVG | 완료 |
| SQL 추출 (전체 / 변경분, CREATE·ALTER·DROP 구분, 경고) | 완료 |
| 테이블 정의서 Excel | 완료 |
| DB에서 가져오기 / DB로 내보내기 (MySQL, PostgreSQL) | 완료 |
| 서버 프로젝트 저장 + Yjs 실시간 동시 편집 + 커서·선택 표시 | 완료 |
| 버전 (서버 저장, 자동 저장, 복원) | 완료 |
| MCP (로컬 stdio + 원격 HTTP), AI 바로 적용 + 되돌리기, 제안 모드 | 완료 |
| 로그인·권한, 외부 배포 | 남음 |
| 3방향 비교 (마지막 동기화 시점 기준 충돌 표시) | 남음 |
| 이름 변경 추정 (삭제+추가 → RENAME 제안) | 남음 |

## 7. 진행 순서

1. core(모델·비교·SQL 생성) + 혼자 쓰는 편집기 + 인덱스 + SQL 추출(전체/변경분) + PNG/SVG
2. SQL 붙여넣기, 논리/물리명 전환, 테이블 정의서 Excel
3. 버전 이력 + 비교 화면
4. 서버, 로그인, Yjs 실시간 편집, 링크 공유
5. DB 연동: 갱신(DB→ERD), 바로 적용(ERD→DB), 로컬 에이전트
6. MCP 서버: 바로 적용 + 되돌리기, 제안 모드
7. 배포 + README
