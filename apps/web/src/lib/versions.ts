import type { VersionInfo } from './api';

// 버전 = 어느 시점의 ERD를 사진처럼 남겨 둔 것. 지금 ERD는 편집할 때마다 실시간으로 저장되므로 버전과 별개다.
// 버전은 사람이 직접 저장하거나, DB 가져오기·내보내기 / AI 제안 반영 / 복원 직전에 자동으로 남는다.

export const VERSION_KIND: Record<VersionInfo['source'], { label: string; hint: string }> = {
  manual: { label: '직접 저장', hint: '사람이 "지금 상태 저장"으로 남긴 버전' },
  db: { label: 'DB 연동', hint: 'DB에서 가져오거나 DB로 내보낼 때 자동으로 남은 버전 (그 시점에 DB와 맞춘 ERD)' },
  ai: { label: 'AI', hint: 'AI 작업 때 자동으로 남은 버전' },
  auto: { label: '자동', hint: '복원·AI 제안 반영·DB 작업 직전에 되돌릴 수 있게 자동으로 남은 버전' },
};

/** 고르기 목록에서 묶는 순서 */
export const VERSION_GROUPS: { title: string; sources: VersionInfo['source'][] }[] = [
  { title: '직접 저장', sources: ['manual'] },
  { title: 'DB 연동 (DB와 맞춘 시점)', sources: ['db'] },
  { title: '자동 저장 (작업 직전 백업)', sources: ['auto', 'ai'] },
];

/** 변경분 SQL의 기본 시작점: 마지막으로 DB와 맞춘 버전 → 없으면 마지막 직접 저장 → 없으면 최근 버전 */
export function defaultBaseVersion(versions: VersionInfo[]): VersionInfo | undefined {
  return versions.find((v) => v.source === 'db') ?? versions.find((v) => v.source === 'manual') ?? versions[0];
}

export const versionTime = (v: VersionInfo) => new Date(v.createdAt).toLocaleString();
