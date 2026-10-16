import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerErdTools, type ErdApi, type ToolOptions } from './tools';

export { registerErdTools, httpApi, type ErdApi, type ToolOptions } from './tools';

const INSTRUCTIONS = [
  'ERD(데이터베이스 설계도) 도구입니다.',
  '작업 순서: list_projects로 프로젝트를 찾고, get_schema로 지금 구조를 확인한 뒤, edit_schema로 고칩니다.',
  'FK는 addRelation으로 만들면 자식 테이블에 FK 컬럼이 자동으로 생깁니다. 외래키 이름은 겹치지 않게 자동으로 정해집니다 (fk_자식_부모, 이미 있으면 fk_자식_FK컬럼). check_design에 "외래키 이름 겹침"이 나오면 updateRelation(newName)으로 안내한 이름으로 바꿉니다.',
  '테이블과 컬럼에는 한글 논리명(logicalName)도 함께 넣어 주세요.',
  'DB로 내보내기(db_push): 사용자의 ERD 앱이 DB에 접속해 실행합니다 (앱이 켜져 있어야 함). DB 실행은 되돌리기 어려워 프로젝트 AI 모드와 상관없이 항상 사용자가 앱에서 SQL을 보고 승인해야 실행됩니다 (승인을 기다리면 db_job_result로 결과 확인). 가져오기(db_pull)는 AI 모드를 따릅니다. 테이블·타입 삭제(DROP)는 사용자가 원할 때만 include_drop=true로 넣습니다. 실패하면 결과의 failedStatements.diagnosis(원인·조치·누가 고칠지)를 보고, AI가 고칠 수 있는 것은 edit_schema로 고친 뒤 다시 db_push하고, 사람이 해야 하는 것(데이터 정리·DB 확장·권한)은 사용자에게 알립니다.',
  'DB 작업은 모두 사용자 PC의 ERD 앱이 로컬에서 DB에 접속해 합니다 (사내망·방화벽 안 DB도 PC에서 접속되면 됨, 서버는 DB에 접속하지 않음). 사용자가 접속 정보를 주며 DB를 가져오라고 하면: create_connection(project 지정, 접속 확인 후 저장) → db_pull(apply=true) → 결과의 unassignedTables를 기능별로 createArea·addToArea로 묶고 영역마다 auto_layout(area) → 무엇을 가져왔고 영역을 어떻게 나눴는지 보고합니다. 제안 모드 프로젝트는 가져오기가 제안으로 쌓이니 사용자에게 검토를 부탁합니다.',
  'DB 연결: create_connection·update_connection은 저장하기 전에 항상 실제로 접속해 확인합니다. 실패하면 diagnosis(원인·조치·누가 고칠지)를 보고, AI가 고칠 수 있는 연결 정보(호스트·포트·DB 이름·SSL)는 고쳐 다시 시도하고, 비밀번호·서버 켜기·방화벽·권한처럼 사람이 해야 하는 것은 사용자에게 알립니다. 비밀번호는 추측하지 않고 사용자에게 받습니다. test_connection으로 저장된 연결을 확인할 수 있습니다.',
  '설계 검토: 설계 작업(edit_schema 여러 번)을 마치면 한 번 check_design으로 기본 검사와 지난 AI 검토를 읽고, 직접 설계를 검토해 save_design_review로 오류(error)·경고(warning)·참고(info)를 저장합니다. 명령마다 검토하지 않습니다.',
  '기능을 추가했으면 새로 만들거나 고친 테이블과 그 관계 상대만 검토하고 save_design_review의 tables에 그 이름들을 넣습니다 (다른 테이블의 기존 지적은 남음). edit_schema 결과의 designReview에 검토가 필요한 테이블이 나옵니다.',
  '사람이 무시한 항목(check_design에 나오지 않음)은 고치지 않습니다. 검토 항목을 고쳤으면 resolve_design_review로 해결 표시하고, 사용자에게 오류·경고·참고별로 무엇을 고쳤고 무엇을 남겼는지 알려 줍니다.',
  '주제영역: 큰 ERD는 화면에서 탭(주문·회원·정산 등)으로 나눠 봅니다. 새 기능을 설계하거나 DB를 가져와 테이블이 많아지면 기능별로 edit_schema의 createArea·addToArea·moveToArea로 묶어 주세요. 여러 기능이 함께 쓰는 테이블(예: 회원)은 여러 영역에 넣어도 됩니다. 영역 색은 그 영역 테이블 색으로도 칠해지니(colorTables 기본 true) 영역마다 구분되는 색을 주고, 공통 테이블은 첫 영역(탭 순서)의 색을 쓰니 주로 속하는 영역을 먼저 만듭니다. 이미 있는 영역의 테이블 색을 영역 색에 맞춰 달라고 하면 영역마다 updateArea(colorTables=true)를 부릅니다. 사용자가 테이블 색을 따로 원하면 colorTables=false.',
  '영역을 새로 묶었으면 영역마다 auto_layout(area)으로 그 탭의 배치를 정리합니다 (안 하면 전체 ERD 위치 그대로라 흩어져 보임). 새 테이블은 createTable의 area로 영역에 바로 넣습니다. 영역 단위로 볼 때는 get_schema·check_design에 area를 줍니다. 영역은 화면 구분일 뿐 SQL·DB에는 영향이 없고, 제안 모드에서도 영역 명령만 있으면 바로 반영됩니다.',
  '영향도: edit_schema 결과의 impact에 함께 사라진 외래키·인덱스나 타입이 어긋난 FK 컬럼이 나오면, 의도와 다른 것은 이어서 고치고 사용자에게 알려 줍니다. 테이블·컬럼을 지우기 전에는 get_schema의 relations로 참조하는 테이블을 먼저 확인합니다.',
  '이름 표기 기준: get_schema의 project.namingStyle에 이 프로젝트의 물리명 표기(snake_case·SNAKE_CASE·camelCase)가 나옵니다. 테이블과 컬럼의 기준이 다를 수 있으니(예: 테이블 camelCase, 컬럼 snake_case) 각각 그 표기로 만듭니다. 아직 정해지지 않았으면 처음 만든 표기가 테이블·컬럼 따로 기준으로 저장되어 다음 명령부터 그 기준을 따릅니다 (snake_case 권장). edit_schema 결과의 naming에 기준과 다른 이름이 나오면 바로 고칩니다.',
  '표준 용어 사전: get_schema의 project.dictionary에 사전이 있다고 나오면, 설계 전에 lookup_dictionary(names·tables)로 논리명의 표준 물리명·타입·길이를 찾아 그대로 씁니다. 사전 표기는 프로젝트 이름 표기 기준과 같습니다. 사전에 없는 용어는 edit_schema가 반영될 때 사전에 자동으로 추가되고(같은 논리명이 이미 있으면 추가 안 됨. 논리명이 다르면 물리명이 같아도 됨) 결과의 dictionaryAdded에 나옵니다. 결과의 dictionary에 사전과 다른 컬럼·테이블이 나오면 고칩니다. 같은 이름·같은 논리명의 테이블은 만들 수 없습니다.',
  '사용자 정의 타입(ENUM): 상태·구분처럼 값이 정해진 컬럼은 edit_schema의 createEnum으로 타입을 만들고 컬럼 type에 그 이름을 씁니다 (PostgreSQL은 CREATE TYPE, MySQL·MariaDB는 컬럼별 ENUM, Oracle·SQL Server는 VARCHAR로 만들어짐). get_schema의 enums에 있는 타입을 먼저 확인하고, 같은 값 목록의 타입을 또 만들지 않습니다.',
  'DB 기능: get_schema의 project.features.notAvailable에 있는 기능(예: Oracle의 ENUM, MySQL의 부분 인덱스)은 그 DB에 없어 명령이 거절됩니다. available에 있는 기능만 씁니다.',
  'DB 종류: 프로젝트의 DB 종류(get_schema의 project.dialect)는 만들 때 정하며 바꿀 수 없습니다. 그 DB에 있는 타입·기능으로만 설계하고, 다른 DB로 변환하지 않습니다. db_pull·db_push는 같은 DB 종류의 연결만 씁니다.',
  '용어 규칙(사전과 같은 검사): AI가 만든 ERD는 그대로 표준 용어 사전에 넣을 수 있어야 합니다. 사전이 없어도 같은 논리명이면 ERD 어디서나 같은 물리명·타입으로 씁니다 (예: 생성일시는 모두 created_at). edit_schema 결과의 terms는 사전 화면의 "ERD에서 만들기" 검사와 같은 규칙으로 걸린 것이니 바로 고칩니다 (같은 뜻이면 맞추고, 다른 뜻이면 논리명을 구분). 논리명이 다르면 물리명은 같아도 됩니다 (예: 결제상태·구독상태 → status).',
  'DB 객체(뷰·함수·프로시저·트리거 등): get_schema의 objects에 종류·이름이, get_db_objects에 전체 DDL이 있습니다. 프로젝트 DB 문법의 CREATE 문 그대로 edit_schema의 createObject·updateObject(definition)·dropObject로 고치고, db_push로 DB에 반영합니다 (바뀐 것만 지웠다 다시 만들고, 실패하면 diagnosis를 보고 고칩니다). 테이블·컬럼 이름을 바꾸면 그것을 쓰는 뷰·트리거의 DDL도 함께 고칩니다.',
  '개인정보: 이름·연락처·이메일·주소·생년월일·주민등록번호·계좌·카드·비밀번호 같은 컬럼을 만들면 컬럼의 privacy(종류)를 함께 넣습니다. 주민등록번호 등 고유식별정보·계좌·카드번호는 암호화, 비밀번호는 해시로 저장하도록 설계하고(암호문이 들어갈 길이로) encrypted=true를 넣습니다. check_design의 "개인정보로 보이는 컬럼"은 사용자에게 확인한 뒤 표시합니다.',
  'DB끼리 비교: 사용자가 개발·운영 DB 차이를 물으면 compare_databases(source=기준, target=대상)로 읽고, 배포 누락·운영에만 있는 것 등을 쉬운 말로 요약합니다. 차이를 맞추는 SQL은 보여 주기만 하고 실행하지 않습니다.',
  '테스트 데이터: generate_test_data로 외래키·UNIQUE를 지키는 INSERT를 만듭니다. DB에 넣을 때(insert=true)는 사용자가 앱에서 승인해야 하며, 운영 DB에는 넣지 않습니다.',
  'DB 오류 분석: 사용자가 DB 가져오기·내보내기 오류를 물으면 get_db_errors로 실패한 SQL·DB 오류 메시지·관련 테이블 정의를 읽고 원인을 쉬운 말로 설명합니다. ERD를 고쳐야 하면 edit_schema로 고치고(또는 방법을 제안하고), 다시 실행은 db_push로 합니다 (사용자가 앱에서 승인).',
  '논리명·설명: DB comment에는 테이블·컬럼의 논리명(logicalName)이 들어가고, comment(설명)는 ERD에만 저장되는 상세 설명입니다. 논리명은 꼭 넣고, 설명은 필요할 때만 자세히 씁니다.',
  '메모: 사용자가 설계 설명·주의 사항을 캔버스에 남겨 달라고 하면 edit_notes(add)로 메모를 붙입니다 (영역 탭이면 area). 메모는 SQL·DB에 영향이 없습니다.',
].join('\n');

export function createErdMcpServer(api: ErdApi, options: ToolOptions): McpServer {
  const server = new McpServer({ name: 'erd', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerErdTools(server, api, options);
  return server;
}
