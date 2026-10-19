import { useEffect } from 'react';
import { desktop } from '../lib/desktop';
import { startDesktopUpdateCheck, useDesktopUpdate } from '../lib/desktopUpdate';
import { Modal } from './Modal';
import { Icon } from './ui';
import { NoteText } from './NoteText';

/** 새 버전 안내 창 (설치형 앱에서만). 어느 화면에서든 뜬다 */
export function DesktopUpdateDialog() {
  const { release, open, progress, openedInBrowser, error } = useDesktopUpdate();
  useEffect(() => startDesktopUpdateCheck(), []);
  if (!desktop || !release || !open) return null;
  const busy = progress !== null;
  const canInstallInApp = Boolean(desktop.installUpdate);
  return (
    <Modal
      title="새 버전이 나왔습니다"
      onClose={() => !busy && useDesktopUpdate.getState().close()}
      footer={
        <>
          <button
            className="btn"
            disabled={busy}
            onClick={() => useDesktopUpdate.getState().later()}
            title="오늘은 다시 묻지 않습니다. 위쪽 '업데이트' 버튼으로 언제든 설치할 수 있습니다"
          >
            나중에
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void useDesktopUpdate.getState().install()}>
            {busy ? (progress! >= 0 ? `내려받는 중 ${progress}%` : '내려받는 중…') : openedInBrowser ? '설치 파일 다시 받기' : '지금 업데이트'}
          </button>
        </>
      }
    >
      <div className="desktop-update">
        <p className="desktop-update__versions">
          ERD 앱 <b>{desktop.version}</b> → <b>{release.version}</b> 업데이트가 있습니다. 업데이트하시겠습니까?
        </p>
        <h3>바뀐 점</h3>
        <NoteText text={release.notes} format={release.notesFormat ?? 'markdown'} empty="변경 내용이 적혀 있지 않습니다." />
        {openedInBrowser ? (
          <p className="notice-box">
            브라우저에서 설치 파일(ERD-Setup-{release.version}.exe)을 받고 있습니다. 받은 파일을 실행하면 이 앱이 새 버전으로 바뀝니다. 설치 중 앱을 닫으라고 하면 이 창을 닫아 주세요.
          </p>
        ) : (
          <p className="muted small">
            {canInstallInApp
              ? '지금 업데이트를 누르면 설치 파일을 받아 실행하고 앱이 잠시 닫힙니다. 설치가 끝나면 새 버전으로 열 수 있습니다.'
              : '지금 업데이트를 누르면 브라우저에서 설치 파일을 받습니다. 받은 파일을 실행하면 이 앱이 새 버전으로 바뀝니다.'}{' '}
            저장한 DB 연결 정보는 그대로 남습니다.
          </p>
        )}
        <p className="small">
          <a href={release.page} target="_blank" rel="noreferrer">릴리스 페이지에서 보기</a>
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}

/** 상단의 "업데이트" 버튼: 새 버전이 있을 때만 보인다 */
export function DesktopUpdateButton() {
  const release = useDesktopUpdate((s) => s.release);
  if (!desktop || !release) return null;
  return (
    <button className="btn btn-update" onClick={() => useDesktopUpdate.getState().show()} title={`새 버전 ${release.version}이 있습니다`}>
      <Icon name="download" />
      <span>업데이트</span>
    </button>
  );
}
