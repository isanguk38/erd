import { useEffect, useState } from 'react';
import { hasNewVersion } from '../lib/appVersion';

const CHECK_INTERVAL = 5 * 60 * 1000;

/** 새 버전이 배포되면 화면 아래에 새로고침 안내를 띄운다 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = () => hasNewVersion().then((v) => alive && v && setAvailable(true));
    check();
    const timer = setInterval(check, CHECK_INTERVAL);
    window.addEventListener('focus', check);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, []);

  if (!available || dismissed) return null;
  return (
    <div className="update-banner" role="status">
      <span>새 버전이 배포되었습니다. 새로고침하면 바로 적용됩니다.</span>
      <button className="btn btn-primary" onClick={() => location.reload()}>새로고침</button>
      <button className="icon-btn" onClick={() => setDismissed(true)} title="나중에">×</button>
    </div>
  );
}
