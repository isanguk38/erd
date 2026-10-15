import { useEffect, useState } from 'react';
import { dbJobApi } from '../lib/api';
import { runDbJob, type PushApproval } from '../lib/aiDbJobs';
import { refreshDbStatus } from '../lib/hooks';
import { useStore } from '../store';
import { Modal } from './Modal';

/**
 * AI(MCP)가 요청한 DB 작업을 이 앱이 가져가 처리한다 (DB 연결 만들기·고치기·확인, DB로 내보내기).
 * 웹 서비스 서버는 사용자 PC·사내망 DB에 접속하지 않으므로, 이 계정으로 로그인한 앱이 켜져 있어야 AI가 DB 작업을 할 수 있다.
 * 작업을 가져오는 반복은 앱 전체에 하나만 돈다 (화면이 다시 그려져도 가져간 작업을 잃지 않게).
 * 제안 모드의 내보내기는 승인 창에 SQL을 보여 주고 사람이 승인해야 실행한다.
 */

type Approval = PushApproval & { resolve: (ok: boolean) => void };
const approvals: Approval[] = [];
let showApprovals: (() => void) | null = null;
let started = false;

function askApproval(request: PushApproval): Promise<boolean> {
  return new Promise((resolve) => {
    approvals.push({ ...request, resolve });
    showApprovals?.();
  });
}

function startLoop() {
  if (started) return;
  started = true;
  void (async () => {
    for (;;) {
      let job;
      try {
        job = (await dbJobApi.next(25)).job;
      } catch {
        // 서버가 잠시 안 되면 쉬었다가 다시
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      if (!job) continue;
      const current = job;
      try {
        const result = await runDbJob(current, {
          approve: askApproval,
          notify: (text) => useStore.getState().showNotice({ text }),
          waiting: async () => void (await dbJobApi.update(current.id, { status: 'waiting_approval' }).catch(() => {})),
        });
        await dbJobApi.update(current.id, { status: 'done', result });
        if (current.kind === 'push' || current.kind === 'saveConnection') refreshDbStatus();
      } catch (e) {
        await dbJobApi.update(current.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) }).catch(() => {});
      }
    }
  })();
}

export function AiDbJobRunner() {
  const [approval, setApproval] = useState<Approval | null>(null);

  useEffect(() => {
    startLoop();
    showApprovals = () => setApproval((cur) => cur ?? approvals[0] ?? null);
    showApprovals();
    return () => {
      showApprovals = null;
    };
  }, []);

  if (!approval) return null;
  const answer = (ok: boolean) => {
    approvals.splice(approvals.indexOf(approval), 1);
    approval.resolve(ok);
    setApproval(approvals[0] ?? null);
  };
  const drops = approval.statements.filter((s) => s.category === 'drop').length;
  return (
    <Modal
      title="AI가 DB에 실행하려고 합니다"
      onClose={() => answer(false)}
      wide
      footer={
        <>
          <button className="btn" onClick={() => answer(false)}>거절</button>
          <button className="btn btn-primary" onClick={() => answer(true)}>DB에 실행</button>
        </>
      }
    >
      <p>
        <b>{approval.projectName}</b>의 바뀐 부분 {approval.statements.length}문장을 <b>{approval.connection.name}</b> ({approval.connection.database})에 실행합니다.
        <span className="muted small"> 이 프로젝트는 AI 제안 모드라 실행 전에 승인이 필요합니다. 거절하면 AI에게 거절했다고 알립니다.</span>
      </p>
      {drops > 0 && <div className="error-box">삭제(DROP) {drops}문장이 들어 있습니다. 지워진 테이블·데이터는 되돌릴 수 없습니다.</div>}
      {approval.statements.some((s) => s.warning) && (
        <ul className="dict-notes">{approval.statements.filter((s) => s.warning).map((s, i) => <li key={i}>⚠ {s.warning}</li>)}</ul>
      )}
      <pre className="sql-view small-view">{approval.statements.map((s) => `${s.sql};`).join('\n\n')}</pre>
    </Modal>
  );
}
