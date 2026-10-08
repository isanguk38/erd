import type { ImpactItem } from '@erd/core';

/** 영향도 확인 창. 영향이 없으면 묻지 않고 true */
export function confirmImpact(title: string, items: ImpactItem[]): boolean {
  if (!items.length) return true;
  const lines = items.slice(0, 12).map((i) => `· ${i.text}`);
  if (items.length > 12) lines.push(`… 외 ${items.length - 12}개`);
  return confirm(`${title}\n\n${lines.join('\n')}\n\n계속할까요? (Ctrl+Z로 되돌릴 수 있음)`);
}
