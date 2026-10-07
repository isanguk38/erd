// 설계 검토를 AI에게 맡기기.
// - 설치형 앱(0.2.4+)이고 이 PC에 Claude Code(claude 명령)가 있으면: 앱이 바로 실행한다 (erd 도구만, DB 실행 금지 — desktop/src/ai.ts)
// - 그 밖(웹, 옛 앱, Claude Code 없음): AI에게 보낼 문장을 복사한다
// 실행 중인 상태는 화면 어디서나 볼 수 있게 여기 한곳에 둔다.

import { create } from 'zustand';
import { desktop, viaDesktop } from './desktop';
import { request } from './api';

export type AiMode = 'review' | 'fix';

type AiEvent =
  | { kind: 'start' }
  | { kind: 'tool'; name: string }
  | { kind: 'text'; text: string }
  | { kind: 'done'; ok: boolean; summary: string };

interface AiBridge {
  status(): Promise<{ available: boolean; version?: string; error?: string }>;
  run(request: unknown): Promise<{ ok: boolean; summary: string }>;
  cancel(): Promise<boolean>;
  onEvent(callback: (event: AiEvent) => void): () => void;
}

const bridge = (desktop as unknown as { ai?: AiBridge } | null)?.ai ?? null;

const TOOL_LABEL: Record<string, string> = {
  check_design: '설계 검사 결과 읽는 중',
  get_schema: '설계 읽는 중',
  save_design_review: '검토 결과 저장 중',
  edit_schema: '설계 고치는 중',
  resolve_design_review: '고친 항목 해결 표시 중',
};

interface AiRunState {
  /** 이 PC에서 바로 실행할 수 있는지 (null = 확인 전) */
  available: boolean | null;
  unavailableReason?: string;
  running: { projectId: string; mode: AiMode; step: string } | null;
  result: { projectId: string; ok: boolean; summary: string } | null;
  clearResult(): void;
}

export const useAiRun = create<AiRunState>((set) => ({
  available: bridge ? null : false,
  running: null,
  result: null,
  clearResult: () => set({ result: null }),
}));

let checked = false;
/** 이 PC에서 바로 실행할 수 있는지 한 번 확인 (claude 명령 설치 여부) */
export function checkAiAvailable(): void {
  if (!bridge || checked) return;
  checked = true;
  viaDesktop(() => bridge.status())
    .then((s) => useAiRun.setState({ available: s.available, unavailableReason: s.error }))
    .catch((e) => useAiRun.setState({ available: false, unavailableReason: e instanceof Error ? e.message : String(e) }));
}

/** 이 PC의 Claude Code로 바로 실행 */
export async function runAiHere(input: { projectId: string; projectName: string; mode: AiMode; tables?: string[] }): Promise<void> {
  if (!bridge) throw new Error('설치형 앱에서만 바로 실행할 수 있습니다');
  if (useAiRun.getState().running) throw new Error('AI 작업이 이미 진행 중입니다');
  useAiRun.setState({ running: { projectId: input.projectId, mode: input.mode, step: '준비 중' }, result: null });
  const off = bridge.onEvent((e) => {
    if (e.kind === 'tool') useAiRun.setState((s) => (s.running ? { running: { ...s.running, step: TOOL_LABEL[e.name] ?? e.name } } : s));
  });
  try {
    const { url, token } = await request<{ url: string; token: string }>('POST', '/api/ai-run-token');
    // 다른 사람·다른 AI에게 "AI 작업 중"을 알린다
    await request('PATCH', `/api/projects/${input.projectId}`, { aiRun: { mode: input.mode } }).catch(() => {});
    const r = await viaDesktop(() => bridge.run({ ...input, mcpUrl: url, token }));
    useAiRun.setState({ result: { projectId: input.projectId, ...r } });
  } catch (e) {
    useAiRun.setState({ result: { projectId: input.projectId, ok: false, summary: e instanceof Error ? e.message : String(e) } });
  } finally {
    off();
    useAiRun.setState({ running: null });
    await request('PATCH', `/api/projects/${input.projectId}`, { aiRun: null }).catch(() => {});
  }
}

export function cancelAiHere(): void {
  if (bridge) void bridge.cancel();
}
