// DB 오류 진단: 접속·실행 오류 메시지를 보고 원인과 고칠 방법, 누가 고쳐야 하는지 알려 준다.
// AI(MCP)와 화면이 같이 쓴다. AI가 고칠 수 있는 것(ERD·SQL)은 AI가 고치고, 비밀번호·서버·권한처럼 사람만 할 수 있는 것은 사람에게 알린다.

export interface DbErrorDiagnosis {
  /** 원인 (쉬운 말) */
  cause: string;
  /** 고치는 방법 */
  fix: string;
  /** 누가 고치나: ai = AI가 ERD·연결 정보를 고쳐 다시 시도, user = 사람이 해야 함(비밀번호·서버·권한·데이터), either = 둘 다 가능 */
  actor: 'ai' | 'user' | 'either';
}

interface Rule {
  test: RegExp;
  diagnose: (m: RegExpMatchArray) => DbErrorDiagnosis;
}

// ── 접속 ──────────────────────────────
const CONNECT: Rule[] = [
  {
    test: /ECONNREFUSED|connection refused|could not connect to server|Can't connect to (MySQL|local MySQL) server/i,
    diagnose: () => ({ cause: 'DB 서버에 연결할 수 없습니다 (서버가 꺼져 있거나 포트가 다름)', fix: 'DB 서버가 켜져 있는지 확인하고, 포트 번호가 맞는지 확인하세요 (MySQL 3306, PostgreSQL 5432, SQL Server 1433, Oracle 1521)', actor: 'either' }),
  },
  {
    test: /ENOTFOUND|getaddrinfo|Name or service not known|No such host/i,
    diagnose: () => ({ cause: '호스트 주소를 찾을 수 없습니다 (주소 오타이거나 DNS·사내망 문제)', fix: '호스트 주소를 확인하세요. 사내망·VPN이 필요한 서버면 연결한 뒤 다시 시도하세요', actor: 'either' }),
  },
  {
    test: /ETIMEDOUT|timed? ?out|timeout expired|Connection timeout/i,
    diagnose: () => ({ cause: '응답이 없어 시간이 초과되었습니다 (방화벽·VPN·보안 그룹이 막고 있을 수 있음)', fix: '이 PC에서 DB 서버로 가는 길이 열려 있는지 확인하세요 (VPN 연결, 방화벽·클라우드 보안 그룹의 허용 IP)', actor: 'user' }),
  },
  {
    test: /password authentication failed|Access denied for user|ORA-01017|Login failed for user|28P01|ER_ACCESS_DENIED/i,
    diagnose: () => ({ cause: '아이디 또는 비밀번호가 맞지 않습니다', fix: '올바른 아이디·비밀번호를 사람이 알려 줘야 합니다 (AI가 추측해 넣지 않음)', actor: 'user' }),
  },
  {
    test: /database "?([^"\s]+)"? does not exist|Unknown database '?([^'\s]+)'?|3D000|ER_BAD_DB_ERROR|Cannot open database "?([^"\s]+)"?|ORA-12514|listener does not currently know of service/i,
    diagnose: (m) => ({ cause: `데이터베이스(또는 서비스 이름)${m[1] || m[2] || m[3] ? ` ${m[1] || m[2] || m[3]}` : ''}가 없습니다`, fix: '데이터베이스 이름 오타인지 확인하세요. 아직 없는 DB면 DB 관리자가 먼저 만들어야 합니다 (Oracle은 서비스 이름, 예: FREEPDB1)', actor: 'either' }),
  },
  {
    test: /no pg_hba\.conf entry|host '.*' is not allowed to connect|is not allowed to connect to this MySQL server/i,
    diagnose: () => ({ cause: 'DB 서버가 이 PC(IP)에서의 접속을 허용하지 않습니다', fix: 'DB 관리자가 이 PC의 IP를 허용해야 합니다 (PostgreSQL pg_hba.conf, MySQL 사용자 호스트 권한)', actor: 'user' }),
  },
  {
    test: /SSL|self[- ]signed certificate|certificate|does not support SSL|requires SSL/i,
    diagnose: () => ({ cause: 'SSL(암호화 연결) 설정이 서버와 맞지 않습니다', fix: '연결의 SSL 사용 여부를 바꿔 다시 시도하세요. 서버가 SSL을 요구하면 켜고, 지원하지 않으면 끕니다', actor: 'either' }),
  },
  {
    test: /permission denied|insufficient privilege|command denied|ORA-01031/i,
    diagnose: () => ({ cause: '이 DB 사용자에게 권한이 없습니다', fix: 'DB 관리자가 이 사용자에게 필요한 권한(테이블 조회·변경)을 줘야 합니다', actor: 'user' }),
  },
];

// ── SQL 실행 ──────────────────────────────
const EXECUTE: Rule[] = [
  {
    test: /operator class "?(\w+)"? does not exist|"(\w+)" 연산자 클래스/i,
    diagnose: (m) => ({ cause: `인덱스가 쓰는 연산자 클래스 ${m[1] || m[2]}이(가) DB에 없습니다 (DB 확장이 설치되지 않음. 예: gin_trgm_ops는 pg_trgm)`, fix: 'DB 관리자가 확장을 설치하거나(CREATE EXTENSION IF NOT EXISTS pg_trgm), 필요 없으면 ERD에서 그 인덱스를 지우세요', actor: 'either' }),
  },
  {
    test: /constraint "?(\w+)"? (for relation "?\w+"? )?already exists|제약 조건이 이미|Duplicate foreign key constraint name|ER_FK_DUP_NAME|already used by an existing constraint/i,
    diagnose: (m) => ({ cause: `제약 이름${m[1] ? ` ${m[1]}` : ''}이(가) 이미 있습니다`, fix: 'ERD에서 그 외래키·제약의 이름을 겹치지 않게 바꾸세요 (updateRelation newName)', actor: 'ai' }),
  },
  {
    test: /cannot be cast automatically|cannot cast type|자료형으로 형변환할 수 없습니다|invalid input syntax for type/i,
    diagnose: () => ({ cause: '컬럼 타입을 바꾸면서 지금 값을 새 타입으로 바꿀 수 없습니다', fix: '데이터를 먼저 새 타입에 맞게 정리하거나, 타입 변경을 다시 생각하세요 (예: 글자 → 숫자 변경인데 숫자가 아닌 값이 있음)', actor: 'either' }),
  },
  {
    test: /invalid input value for enum|enum 형식에 잘못된 입력값|Data truncated for column/i,
    diagnose: () => ({ cause: '지금 데이터에 새 ENUM 값 목록에 없는 값이 있습니다', fix: '그 값을 ENUM에 추가하거나(updateEnum), 데이터를 먼저 바꾸세요', actor: 'either' }),
  },
  {
    test: /contains null values|cannot be null|null value in column|Invalid use of NULL value|NULL 값/i,
    diagnose: () => ({ cause: 'NOT NULL로 바꾸려는 컬럼에 이미 NULL인 행이 있습니다', fix: 'NULL인 행을 먼저 채우거나, 컬럼 기본값을 넣거나, NOT NULL을 풀어 두세요', actor: 'either' }),
  },
  {
    test: /could not create unique index|Duplicate entry|duplicate key value|중복된 키/i,
    diagnose: () => ({ cause: '유니크(UNIQUE)로 만들려는 컬럼에 같은 값이 여러 번 있습니다', fix: '중복 데이터를 먼저 정리하거나, 유니크를 빼세요', actor: 'either' }),
  },
  {
    test: /value too long|Data too long|String or binary data would be truncated|ORA-12899/i,
    diagnose: () => ({ cause: '컬럼 길이를 줄이려는데 그보다 긴 값이 있습니다', fix: '길이를 더 크게 두거나, 긴 값을 먼저 정리하세요', actor: 'either' }),
  },
  {
    test: /violates foreign key constraint|foreign key constraint fails|Cannot add or update a child row/i,
    diagnose: () => ({ cause: '외래키를 걸려는 컬럼에 부모 테이블에 없는 값이 있습니다', fix: '부모에 없는 값을 가진 행을 정리하거나, 외래키를 빼세요', actor: 'either' }),
  },
  {
    test: /(relation|table) "?(\w+)"? already exists|Table '?(\w+)'? already exists/i,
    diagnose: (m) => ({ cause: `테이블 ${m[2] || m[3]}이(가) DB에 이미 있습니다`, fix: 'DB에서 가져오기로 지금 DB 구조를 ERD와 맞춘 뒤 다시 내보내세요', actor: 'either' }),
  },
  {
    test: /(relation|table|column) "?(\w+)"? does not exist|Unknown column|Table '.*' doesn't exist/i,
    diagnose: () => ({ cause: 'SQL이 가리키는 테이블·컬럼이 DB에 없습니다 (그 사이 DB가 바뀌었을 수 있음)', fix: 'DB에서 가져오기로 지금 DB 구조를 확인한 뒤 다시 내보내세요', actor: 'either' }),
  },
  {
    test: /depends on|cannot drop .* because other objects depend|is referenced by|Cannot drop index .* needed in a foreign key/i,
    diagnose: () => ({ cause: '다른 것(외래키·뷰·인덱스)이 이것을 쓰고 있어 지우거나 바꿀 수 없습니다', fix: '먼저 그것을 쓰는 외래키·뷰를 정리하세요', actor: 'either' }),
  },
];

/** 오류 메시지 진단. 모르는 오류면 null (원문 그대로 보고 판단) */
export function diagnoseDbError(message: string, stage: 'connect' | 'execute'): DbErrorDiagnosis | null {
  const rules = stage === 'connect' ? [...CONNECT, ...EXECUTE] : [...EXECUTE, ...CONNECT];
  for (const rule of rules) {
    const m = message.match(rule.test);
    if (m) return rule.diagnose(m);
  }
  return null;
}
