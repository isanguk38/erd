import { Modal } from './Modal';
import { desktop, DESKTOP_DOWNLOAD_URL } from '../lib/desktop';
import { useDbAvailable } from '../lib/hooks';

const SHORTCUTS: [string[], string][] = [
  [['Ctrl', 'F'], '테이블·컬럼 찾기'],
  [['Ctrl', 'Z'], '되돌리기 (내가 한 변경만)'],
  [['Ctrl', 'Y'], '다시 실행'],
  [['Delete'], '고른 테이블·관계 삭제'],
  [['더블클릭'], '빈 곳에 테이블 추가'],
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
            <li>테이블을 클릭하면 오른쪽에서 컬럼(물리명·논리명·타입·PK·NN·UQ·기본값)과 <b>인덱스</b>를 편집합니다.</li>
            <li>테이블 오른쪽의 <b>점을 끌어</b> 다른 테이블에 놓으면 관계(FK)가 생깁니다. <b>끌기 시작한 쪽이 부모</b>이고, 자식에 FK 컬럼이 자동으로 생깁니다.</li>
            <li>관계 종류(1:N 비식별·식별, 1:1, N:M)는 도구 막대의 <b>관계</b> 메뉴에서 고릅니다. N:M은 연결 테이블을 만들어 줍니다.</li>
            <li><b>물리명 / 논리명 / 둘 다</b>로 이름 표시를 바꿉니다.</li>
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
