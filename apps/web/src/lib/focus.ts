// 새로 만든 테이블·컬럼의 이름 칸으로 바로 커서를 옮긴다.
// 만드는 쪽에서 requestFocus(키)를 부르고, 그 칸이 화면에 그려질 때 takeFocus(키)가 참이면 포커스한다.

let pending: string | null = null;

export function requestFocus(key: string): void {
  pending = key;
}

/** 이 칸이 요청된 칸이면 한 번만 참 */
export function takeFocus(key: string | undefined): boolean {
  if (!key || pending !== key) return false;
  pending = null;
  return true;
}
