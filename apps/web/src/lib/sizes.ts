import { estimateTableSize, type SizeOf } from '@erd/core';

/** 화면에 그려진 테이블 크기 (없으면 추정값). 영역 소속을 정할 때 쓴다 */
let measured: Map<string, { width: number; height: number }> = new Map();

export function setMeasuredSizes(sizes: Map<string, { width: number; height: number }>): void {
  measured = sizes;
}

export function measuredSizeOf(): SizeOf {
  return (table) => measured.get(table.id) ?? estimateTableSize(table);
}
