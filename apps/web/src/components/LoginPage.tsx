import { useState } from 'react';
import { authApi, type Me } from '../lib/api';

export function LoginPage({ me, onLoggedIn }: { me: Me; onLoggedIn: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const joining = location.hash.startsWith('#/join/');

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>ERD</h1>
        <p className="muted">함께 그리고, DB와 바로 동기화하고, AI와 같이 설계하는 ERD</p>
        {joining && <div className="ok-box">초대 링크로 들어왔습니다. 로그인하면 프로젝트에 참여합니다.</div>}
        {me.loginMethods.includes('github') && (
          <a className="btn btn-primary btn-lg" href="/auth/github">
            GitHub로 로그인
          </a>
        )}
        {me.loginMethods.includes('dev') && (
          <form
            className="dev-login"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await authApi.devLogin(name);
                onLoggedIn();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <span className="muted small">개발용 로그인 (이름만)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름" />
            <button className="btn" type="submit" disabled={!name.trim()}>로그인</button>
          </form>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}
