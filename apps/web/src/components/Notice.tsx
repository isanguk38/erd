import { useEffect } from 'react';
import { useStore } from '../store';

/** 화면 아래 잠깐 뜨는 안내. 버튼이 있으면 누를 수 있게 8초간 보여준다 */
export function Notice() {
  const notice = useStore((s) => s.notice);
  const showNotice = useStore((s) => s.showNotice);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => showNotice(null), notice.action ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice, showNotice]);
  if (!notice) return null;
  return (
    <div className="update-banner notice" role="status">
      <span>{notice.text}</span>
      {notice.action && (
        <button
          className="btn btn-primary"
          onClick={() => {
            notice.action!.run();
            showNotice(null);
          }}
        >
          {notice.action.label}
        </button>
      )}
      <button className="icon-btn" onClick={() => showNotice(null)} title="닫기">×</button>
    </div>
  );
}
