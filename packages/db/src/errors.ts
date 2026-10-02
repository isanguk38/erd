/**
 * DB 연결 객체의 'error' 이벤트를 받아 둔다.
 * 쿼리 중에 연결이 끊기면 드라이버가 'error' 이벤트를 내는데, 받는 쪽이 없으면 Node가 "처리되지 않은 예외"로
 * 프로그램 전체를 멈춘다(설치형 앱에서는 오류 창). 실제 실패는 진행 중인 쿼리의 오류로 이미 전달된다.
 */
export function guardErrors(emitter: { on(event: 'error', listener: (e: Error) => void): unknown }): void {
  emitter.on('error', () => {
    /* 진행 중인 쿼리가 같은 오류로 실패하므로 여기서는 삼킨다 */
  });
}

/** 연결이 끊긴 오류를 알아보기 쉽게 */
export function explainConnectionError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (/Connection terminated|ECONNRESET|socket hang up|Connection lost|PROTOCOL_CONNECTION_LOST|ESOCKET|NJS-500|DPI-1080/i.test(message)) {
    return new Error(`DB 연결이 중간에 끊겼습니다 (네트워크·방화벽, 또는 DB 서버가 연결을 닫음). 잠시 뒤 다시 시도하세요.\n(${message})`);
  }
  if (/NJS-515/.test(message)) return new Error(`Oracle 접속 주소 형식이 올바르지 않습니다. 서비스 이름(예: FREEPDB1, ORCLPDB1)과 포트를 확인하세요.
(${message})`);
  return e instanceof Error ? e : new Error(message);
}
