// 컬럼 줄의 기능 버튼 (기본값 칸 옆).
// - 계산 컬럼(generated): ƒ — 다른 컬럼으로 값을 계산 (그 DB가 되는 저장 방식만: VIRTUAL·STORED)
// - ON UPDATE CURRENT_TIMESTAMP(onUpdateTimestamp): ↻ — 행이 바뀔 때 현재 시각으로
// 각각 그 모듈이 있는 DB에서만 그려진다.

import type { GeneratedFeature, OnUpdateTimestampFeature } from '@erd/core';
import type { FeatureSlots, SlotProps } from '../registry';

function GeneratedButton({ column: c, setColumn, feature }: SlotProps['columnTools'] & { feature: GeneratedFeature }) {
  // 처음 켤 때: 값을 저장하지 않는 방식(VIRTUAL)이 있으면 그것, 없으면 저장(STORED)
  // 다시 누르면: 둘 다 되는 DB는 VIRTUAL → STORED → 해제, 하나만 되면 바로 해제
  const next = () => {
    if (!c.generated) return { expression: '', stored: !feature.virtual };
    if (!c.generated.stored && feature.stored && feature.virtual) return { ...c.generated, stored: true };
    return undefined;
  };
  return (
    <button
      className={`generated-btn${c.generated ? ' on' : ''}`}
      title={
        c.generated
          ? `계산 컬럼 (${c.generated.stored ? 'STORED: 값을 저장' : 'VIRTUAL: 읽을 때 계산'}) — 누르면 ${!c.generated.stored && feature.stored && feature.virtual ? 'STORED로' : '일반 컬럼으로'}`
          : '계산 컬럼으로 (GENERATED ALWAYS AS): 다른 컬럼으로 값을 계산합니다'
      }
      onClick={() => setColumn({ generated: next(), ...(c.generated ? {} : { defaultValue: null, autoIncrement: false }) })}
    >
      ƒ{c.generated?.stored ? <sub>S</sub> : null}
    </button>
  );
}

function OnUpdateButton({ column: c, mark, setColumn, feature }: SlotProps['columnTools'] & { feature: OnUpdateTimestampFeature }) {
  // 날짜·시각 컬럼에만 (그 DB 모듈이 정한 타입)
  if (!feature.types.test(c.type)) return null;
  return (
    <button
      className={`onupdate-btn${c.onUpdate ? ' on' : ''}${mark ? ` ${mark.className}` : ''}`}
      title={[mark?.title, c.onUpdate ? `ON UPDATE ${c.onUpdate} (행이 바뀔 때마다 현재 시각) — 누르면 끕니다` : '행이 바뀔 때마다 현재 시각으로 (ON UPDATE CURRENT_TIMESTAMP)'].filter(Boolean).join('\n\n')}
      // 자릿수는 컬럼의 소수 초 자릿수(0~6)와 같아야 한다
      onClick={() => setColumn({ onUpdate: c.onUpdate ? undefined : /^[1-6]$/.test(c.length.trim()) ? `CURRENT_TIMESTAMP(${c.length.trim()})` : 'CURRENT_TIMESTAMP' })}
    >
      ↻
    </button>
  );
}

export const generatedUi: FeatureSlots<GeneratedFeature> = { columnTools: GeneratedButton };
export const onUpdateTimestampUi: FeatureSlots<OnUpdateTimestampFeature> = { columnTools: OnUpdateButton };
