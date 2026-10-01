# ERD

함께 그리고, **DB와 바로 동기화**하고, **AI(MCP)와 같이 설계**하는 ERD 도구.

- **DB에서 가져오기**: MySQL·PostgreSQL에 직접 연결해 구조(테이블·컬럼·인덱스·FK·코멘트)를 읽어 ERD를 만들거나, 바뀐 부분만 ERD에 반영한다. 배치·색상·논리명은 유지한다.
- **DB로 내보내기**: ERD와 DB를 비교해 **바뀐 부분만** 실행한다. 새 테이블은 CREATE, 기존 테이블은 ALTER, 인덱스·FK까지. 바뀌지 않은 테이블은 건드리지 않고, DROP은 기본으로 제외한다.
- **실시간 동시 편집**: 같은 프로젝트를 여러 사람이 동시에 고쳐도 충돌하지 않는다 (Yjs CRDT). 다른 사람의 커서와 선택이 보인다.
- **AI 연결 (MCP)**: Claude Code·Claude Desktop·Cursor 등에서 "쿠폰 테이블 설계해줘"라고 하면 AI가 ERD를 고친다. 바로 적용(한 번에 되돌리기 가능) 또는 제안 모드(사람이 항목별 승인).
- **SQL 추출**: 전체 CREATE 또는 기준 버전 이후 변경분만. CREATE / ALTER / DROP을 나눠 보여주고, 위험한 변경에는 경고를 단다.
- **테이블 정의서 Excel**: 표지·목록·테이블별 컬럼/인덱스/FK·변경 이력.
- **논리명/물리명 전환**, 버전 저장/비교/복원, 자동 배치, PNG/SVG.

## 실행

```bash
npm install
npm run dev
```

- 화면: http://localhost:5173
- 서버: http://127.0.0.1:4000 (DB 연결과 프로젝트 저장을 맡는다. 기본으로 내 PC에서만 접속 가능)

데이터는 `apps/server/data/`에 저장된다 (git에 올라가지 않음).

| 파일 | 내용 |
|---|---|
| `projects/<id>/doc.ydoc` | ERD 본문 (Yjs 문서) |
| `projects/<id>/versions.json` | 버전 |
| `projects/<id>/proposals.json` | AI 제안 |
| `connections.json` | DB 접속 정보 (비밀번호는 AES-256-GCM 암호화) |
| `secret.key` | 비밀번호 암호화 키 (`ERD_SECRET` 환경 변수로 대신할 수 있음) |
| `mcp-token` | 원격 MCP 토큰 (`ERD_MCP_TOKEN`으로 대신할 수 있음) |
| `apply-log.jsonl` | DB에 실행한 SQL 기록 |

## AI 연결 (MCP)

화면 오른쪽 위 **AI** 버튼에 내 PC에 맞는 설정이 나온다.

**Claude Code**

```bash
claude mcp add erd -e ERD_SERVER_URL=http://127.0.0.1:4000 -- node <ERD 폴더>/packages/mcp/bin/erd-mcp.mjs
```

**Claude Desktop / Cursor** (`mcpServers`)

```json
{
  "mcpServers": {
    "erd": {
      "command": "node",
      "args": ["<ERD 폴더>/packages/mcp/bin/erd-mcp.mjs"],
      "env": { "ERD_SERVER_URL": "http://127.0.0.1:4000" }
    }
  }
}
```

**원격 (Streamable HTTP)**: `http://127.0.0.1:4000/mcp`, 헤더 `Authorization: Bearer <apps/server/data/mcp-token>`

| 도구 | 하는 일 |
|---|---|
| `list_projects`, `create_project`, `get_schema` | 프로젝트와 구조 읽기 |
| `edit_schema` | 이름으로 테이블·컬럼·인덱스·관계 편집 (여러 명령을 한 번에, 전부 성공 또는 전부 실패) |
| `import_ddl` | DDL을 읽어 ERD에 합치기 |
| `export_sql`, `export_definition_excel` | SQL·정의서 만들기 |
| `save_version`, `list_versions`, `diff_versions` | 버전 |
| `db_pull`, `db_push` | DB와 비교·반영 (`db_push` 실행은 프로젝트 허용 + DB 이름 확인 필요) |
| `list_proposals`, `undo_ai_changes`, `auto_layout`, `list_connections` | 기타 |

AI가 바로 적용한 변경은 화면에 "AI가 N건 바꿨습니다 · AI 변경 되돌리기" 알림으로 보인다.
제안 모드에서는 AI의 변경이 하나의 제안으로 모이고, 사람이 항목별로 골라 반영한다.

## 구조

```
packages/core   스키마 모델, 비교 엔진(diff), MySQL/PostgreSQL SQL 생성, DDL 파서, Yjs 변환, 편집 명령, 정의서, 자동 배치
packages/db     DB 연결: 구조 읽기(information_schema / pg_catalog), SQL 실행
packages/mcp    MCP 도구 (로컬 stdio + 원격에서 공용)
apps/server     Fastify: 프로젝트 저장, Yjs WebSocket 동기화, REST API, DB 연결, 원격 MCP
apps/web        React + React Flow 편집기
```

핵심은 **하나의 스키마 모델과 하나의 비교 엔진**이다. 버전 비교, 변경분 SQL, DB 가져오기, DB 내보내기, AI 제안 검토가 모두 `diff(A, B)` 하나로 동작한다.
DB에서 읽은 스키마에는 id가 없으므로, 이름으로 ERD와 맞춘 뒤(`alignToCurrent`) 비교한다.
자세한 설계는 [docs/DESIGN.md](docs/DESIGN.md).

## 새 DB 추가하기

1. `packages/core/src/dialects/<db>.ts`: SQL 문법 (`Dialect` 구현) → `dialects/index.ts`에 등록
2. `packages/db/src/<db>.ts`: 구조 읽기·실행 (`Connector` 구현) → `packages/db/src/index.ts`에 등록
3. `DialectId`에 이름 추가

화면, 비교 엔진, 정의서, MCP는 바꾸지 않아도 된다.

## 테스트

```bash
npm test
```

PostgreSQL 연동은 [PGlite](https://pglite.dev)(실제 PostgreSQL을 WASM으로 실행)로 테스트한다: ERD로 DB를 만들고, 다시 읽으면 같은지, 바뀐 부분만 실행하는지, 실패하면 되돌리는지.

## 주의

- 서버는 DB 접속 정보와 실행 권한을 다루므로 기본으로 `127.0.0.1`에서만 연다. 외부에 공개하려면 로그인·권한 확인을 먼저 붙여야 한다.
- MySQL은 DDL을 트랜잭션으로 되돌릴 수 없어 한 문장씩 실행하고, 실패하면 그 자리에서 멈춘다. PostgreSQL은 한 트랜잭션으로 실행해 실패하면 모두 되돌린다.
