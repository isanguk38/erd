import { Modal } from './Modal';
import { desktop, DESKTOP_DOWNLOAD_URL } from '../lib/desktop';
import { useDbAvailable } from '../lib/hooks';

const SHORTCUTS: [string[], string][] = [
  [['Ctrl', 'F'], '테이블·컬럼 찾기'],
  [['Shift', '끌기'], '상자로 여러 테이블 고르기'],
  [['Ctrl', '클릭'], '테이블 하나씩 더 고르기'],
  [['Ctrl', 'C / V'], '고른 테이블 복사·붙여넣기'],
  [['Ctrl', 'A'], '테이블 모두 고르기'],
  [['Ctrl', 'Z'], '되돌리기 (내가 한 변경만)'],
  [['Ctrl', 'Y'], '다시 실행'],
  [['Delete'], '고른 테이블·관계 삭제'],
  [['더블클릭'], '빈 곳에 테이블 추가, 테이블·관계선은 편집 창 열기'],
  [['Esc'], '창·검색 닫기'],
  [['휠'], '확대·축소'],
  [['빈 곳 끌기'], '화면 이동'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const dbAvailable = useDbAvailable();
  return (
    <Modal title="사용 방법" onClose={onClose} wide>
      <div className="help-grid">
        <section className="help-card">
          <h4>1. ERD 그리기</h4>
          <ul>
            <li>빈 곳을 <b>더블클릭</b>하거나 <b>+ 테이블</b>로 테이블을 만듭니다.</li>
            <li>테이블(관계선)을 <b>더블클릭</b>하면 오른쪽에서 컬럼(물리명·논리명·타입·PK·NN·UQ·기본값)과 <b>인덱스</b>를 편집합니다.</li>
            <li>테이블 오른쪽의 <b>점을 끌어</b> 다른 테이블에 놓으면 관계(FK)가 생깁니다. <b>끌기 시작한 쪽이 부모</b>이고, 자식에 FK 컬럼이 자동으로 생깁니다.</li>
            <li>관계 종류(1:N 비식별·식별, 1:1, N:M)는 도구 막대의 <b>관계</b> 메뉴에서 고릅니다. N:M은 연결 테이블을 만들어 줍니다.</li>
            <li><b>물리명 / 논리명 / 둘 다</b>로 이름 표시를 바꿉니다.</li>
            <li>여러 테이블을 고르면 오른쪽에서 <b>색상을 한 번에</b> 바꾸고, 템플릿 적용·복사·삭제를 할 수 있습니다.</li>
            <li><b>주제영역</b>: 캔버스 위 탭(<b>+ 영역</b>)으로 큰 ERD를 "주문", "회원"처럼 나눠 봅니다. 같은 테이블을 여러 영역에 넣을 수 있고, 다른 영역 테이블과의 관계는 <b>점선 카드</b>로 보입니다(누르면 그 영역으로). 테이블을 <b>꾹 누른 채(움직이지 않고 잠깐) 탭으로 끌어 놓으면</b> 그 영역으로 옮겨지고(다른 테이블은 흐려지고 화면은 움직이지 않음), 영역 탭에서 Ctrl+V는 복사본 대신 같은 테이블을 그 영역에 넣고(이미 있으면 그대로), 영역 탭에서 Delete는 그 영역에서만 뺍니다(테이블 삭제는 전체 탭에서), 편집 창의 영역 칸이나 여러 개 선택에서도 넣기·옮기기·빼기를 합니다. SQL·DB에는 영향이 없습니다.</li>
            <li><b>메모</b>: 도구 막대의 <b>메모</b>로 캔버스에 포스트잇을 붙여 설계 의도·주의 사항을 남깁니다. 더블클릭으로 고치고, 고르면 크기·색을 바꾸고 Delete로 지웁니다(Ctrl+Z로 되돌림). 영역 탭에서 붙이면 그 탭에만 보이고, 도면(HTML·이미지) 내보내기에도 들어갑니다. SQL·DB에는 영향이 없습니다.</li>
            <li><b>영향도</b>: 다른 테이블이 참조하는 테이블·컬럼을 지우거나, 컬럼이 인덱스·CHECK·계산식에 쓰이면 지우기 전에 무엇이 함께 바뀌는지 보여 줍니다. PK 타입을 바꾸면 FK로 이어진 컬럼도 같이 바꿀지 묻습니다.</li>
            <li><b>표준 용어 사전</b>: 위의 <b>용어 사전</b>에서 회사 표준 용어 엑셀을 올리면, 컬럼 논리명을 입력할 때 표준 물리명·타입·길이가 채워지고(용어에 없으면 표준 단어를 이어 붙임), 다른 컬럼은 설계 검사에 나옵니다. AI(MCP)도 설계할 때 이 사전을 따릅니다.</li>
          </ul>
        </section>

        <section className="help-card">
          <h4>2. 단축키</h4>
          <table className="shortcut-table">
            <tbody>
              {SHORTCUTS.map(([keys, label]) => (
                <tr key={label}>
                  <td>{keys.map((k) => <kbd key={k}>{k}</kbd>)}</td>
                  <td>{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="help-card">
          <h4>3. DB와 맞추기</h4>
          <ul>
            <li><b>DB에서 가져오기</b>: DB 구조를 읽어 ERD를 만들거나, 바뀐 부분만 반영합니다. 배치·논리명은 유지합니다.</li>
            <li><b>DB로 내보내기</b>: ERD와 DB를 비교해 <b>바뀐 부분만</b> CREATE/ALTER/INDEX로 실행합니다. 테이블 삭제는 기본으로 빠져 있습니다.</li>
            <li><b>안전 검사</b>: 실행 확인 단계에서 지금 DB 데이터를 읽기만 해서, 이대로 실행하면 실패할 변경(NULL인 행에 NOT NULL, 중복 값에 UNIQUE, 더 긴 값에 길이 줄이기, 숫자가 아닌 값에 숫자 타입, 부모에 없는 값에 외래키, 조건에 안 맞는 행에 CHECK)과 데이터가 사라지는 변경(컬럼·테이블 삭제)을 건수와 함께 알려 줍니다. 규칙을 따로 넣을 필요는 없습니다.</li>
            <li>마지막으로 맞춘 뒤 <b>DB에서 바뀜 / ERD에서 바뀜</b>을 나눠 보여주고, 이름 바뀐 컬럼은 "이름 변경인가요?"라고 묻습니다.</li>
            {!dbAvailable && (
              <li className="help-note">
                지금은 웹에서 열려 있어 DB 기능이 꺼져 있습니다. 사내망·내 PC의 DB에 연결하려면{' '}
                <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">설치형 앱</a>을 쓰세요.
              </li>
            )}
            {desktop && <li className="help-note">설치형 앱: DB 접속 정보는 이 PC에만 암호화해 저장합니다.</li>}
          </ul>
        </section>

        <section className="help-card">
          <h4>4. 함께 · 내보내기 · AI</h4>
          <ul>
            <li><b>공유</b>에서 편집/보기 초대 링크를 만들면 다른 사람이 자기 계정으로 들어와 함께 편집합니다. 다른 사람의 커서와 선택이 보입니다.</li>
            <li><b>버전</b>: 저장·복원하고, "지금과 비교"로 바뀐 점을 캔버스에 색으로 봅니다.</li>
            <li><b>추출</b>: SQL(전체 CREATE / 변경분 ALTER), 테이블 정의서(Excel), ERD 도면(HTML·PNG·SVG). HTML은 파일 하나로 확대·검색·컬럼 상세까지 볼 수 있어 공유용으로 좋습니다.</li>
            <li><b>AI</b>: Claude 등과 연결하면 "쿠폰 테이블 설계해줘"처럼 말로 ERD를 고칩니다. 바로 적용(한 번에 되돌리기) 또는 제안 모드(항목별 승인).</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
