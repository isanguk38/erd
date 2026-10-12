import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerErdTools, type ErdApi, type ToolOptions } from './tools';

export { registerErdTools, httpApi, type ErdApi, type ToolOptions } from './tools';

const INSTRUCTIONS = [
  'ERD(데이터베이스 설계도) 도구입니다.',
  '작업 순서: list_projects로 프로젝트를 찾고, get_schema로 지금 구조를 확인한 뒤, edit_schema로 고칩니다.',
  'FK는 addRelation으로 만들면 자식 테이블에 FK 컬럼이 자동으로 생깁니다.',
  '테이블과 컬럼에는 한글 논리명(logicalName)도 함께 넣어 주세요.',
  'DB에 실제로 실행하는 db_push(execute=true)는 반드시 사용자에게 SQL을 보여주고 승인을 받은 뒤에만 호출합니다.',
  '설계 검토: 설계 작업(edit_schema 여러 번)을 마치면 한 번 check_design으로 기본 검사와 지난 AI 검토를 읽고, 직접 설계를 검토해 save_design_review로 오류(error)·경고(warning)·참고(info)를 저장합니다. 명령마다 검토하지 않습니다.',
  '기능을 추가했으면 새로 만들거나 고친 테이블과 그 관계 상대만 검토하고 save_design_review의 tables에 그 이름들을 넣습니다 (다른 테이블의 기존 지적은 남음). edit_schema 결과의 designReview에 검토가 필요한 테이블이 나옵니다.',
  '사람이 무시한 항목(check_design에 나오지 않음)은 고치지 않습니다. 검토 항목을 고쳤으면 resolve_design_review로 해결 표시하고, 사용자에게 오류·경고·참고별로 무엇을 고쳤고 무엇을 남겼는지 알려 줍니다.',
  '주제영역: 큰 ERD는 화면에서 탭(주문·회원·정산 등)으로 나눠 봅니다. 새 기능을 설계하거나 DB를 가져와 테이블이 많아지면 기능별로 edit_schema의 createArea·addToArea·moveToArea로 묶어 주세요. 여러 기능이 함께 쓰는 테이블(예: 회원)은 여러 영역에 넣어도 됩니다.',
  '영역을 새로 묶었으면 영역마다 auto_layout(area)으로 그 탭의 배치를 정리합니다 (안 하면 전체 ERD 위치 그대로라 흩어져 보임). 새 테이블은 createTable의 area로 영역에 바로 넣습니다. 영역 단위로 볼 때는 get_schema·check_design에 area를 줍니다. 영역은 화면 구분일 뿐 SQL·DB에는 영향이 없고, 제안 모드에서도 영역 명령만 있으면 바로 반영됩니다.',
  '영향도: edit_schema 결과의 impact에 함께 사라진 외래키·인덱스나 타입이 어긋난 FK 컬럼이 나오면, 의도와 다른 것은 이어서 고치고 사용자에게 알려 줍니다. 테이블·컬럼을 지우기 전에는 get_schema의 relations로 참조하는 테이블을 먼저 확인합니다.',
  '이름 표기 기준: get_schema의 project.namingStyle에 이 프로젝트의 물리명 표기(snake_case·SNAKE_CASE·camelCase)가 나옵니다. 테이블과 컬럼의 기준이 다를 수 있으니(예: 테이블 camelCase, 컬럼 snake_case) 각각 그 표기로 만듭니다. 아직 정해지지 않았으면 처음 만든 표기가 테이블·컬럼 따로 기준으로 저장되어 다음 명령부터 그 기준을 따릅니다 (snake_case 권장). edit_schema 결과의 naming에 기준과 다른 이름이 나오면 바로 고칩니다.',
  '표준 용어 사전: get_schema의 project.dictionary에 사전이 있다고 나오면, 설계 전에 lookup_dictionary(names·tables)로 논리명의 표준 물리명·타입·길이를 찾아 그대로 씁니다. 사전 표기는 프로젝트 이름 표기 기준과 같습니다. 사전에 없는 용어는 edit_schema가 반영될 때 사전에 자동으로 추가되고(같은 논리명·물리명이 이미 있으면 추가 안 됨) 결과의 dictionaryAdded에 나옵니다. 결과의 dictionary에 사전과 다른 컬럼·테이블이 나오면 고칩니다. 같은 이름·같은 논리명의 테이블은 만들 수 없습니다.',
  '사용자 정의 타입(ENUM): 상태·구분처럼 값이 정해진 컬럼은 edit_schema의 createEnum으로 타입을 만들고 컬럼 type에 그 이름을 씁니다 (PostgreSQL은 CREATE TYPE, MySQL·MariaDB는 컬럼별 ENUM, Oracle·SQL Server는 VARCHAR로 만들어짐). get_schema의 enums에 있는 타입을 먼저 확인하고, 같은 값 목록의 타입을 또 만들지 않습니다.',
  'DB 기능: get_schema의 project.features.notAvailable에 있는 기능(예: Oracle의 ENUM, MySQL의 부분 인덱스)은 그 DB에 없어 명령이 거절됩니다. available에 있는 기능만 씁니다.',
  'DB 종류: 프로젝트의 DB 종류(get_schema의 project.dialect)는 만들 때 정하며 바꿀 수 없습니다. 그 DB에 있는 타입·기능으로만 설계하고, 다른 DB로 변환하지 않습니다. db_pull·db_push는 같은 DB 종류의 연결만 씁니다.',
  '논리명·설명: DB comment에는 테이블·컬럼의 논리명(logicalName)이 들어가고, comment(설명)는 ERD에만 저장되는 상세 설명입니다. 논리명은 꼭 넣고, 설명은 필요할 때만 자세히 씁니다.',
  '메모: 사용자가 설계 설명·주의 사항을 캔버스에 남겨 달라고 하면 edit_notes(add)로 메모를 붙입니다 (영역 탭이면 area). 메모는 SQL·DB에 영향이 없습니다.',
].join('\n');

export function createErdMcpServer(api: ErdApi, options: ToolOptions): McpServer {
  const server = new McpServer({ name: 'erd', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  registerErdTools(server, api, options);
  return server;
}
