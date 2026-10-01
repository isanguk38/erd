export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);
}

/** 파일 이름에 쓸 수 없는 문자 제거 */
export function safeFileName(name: string): string {
  return name.replace(/[\/:*?"<>|]+/g, '_').trim() || 'erd';
}
