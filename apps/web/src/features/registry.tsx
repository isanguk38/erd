// 기능 모듈의 화면 조각을 모아 둔 곳.
// 공통 화면(도구 막대·편집 창·App)은 기능 이름을 모르고 <Slot name="..."/> 자리만 둔다.
// 자리에는 프로젝트 DB가 쓰는 기능 모듈(dialect.features)의 화면 조각만 그려진다 —
// 예) Oracle 프로젝트에는 ENUM 모듈이 없으므로 타입 버튼·타입 창·타입 칸 버튼이 처음부터 없다.
//
// 새 기능 화면은 features/<기능>/ 에 만들고 아래 UI 표에 한 줄 넣는다 (그 기능 모듈이 있는 DB에서만 보인다).

import type { ComponentType } from 'react';
import { getDialect, type Column, type DialectFeatures, type EnumType, type FeatureKey, type Index, type Table } from '@erd/core';
import { useDialect } from '../lib/hooks';
import { enumUi } from './enum';
import { checkUi } from './check';
import { expressionIndexUi, indexMethodsUi, partialIndexUi } from './indexes';
import { generatedUi, onUpdateTimestampUi } from './columnTools';
import type { Mark } from '../components/TextInput';

/** 자리별로 받는 값 */
export interface SlotProps {
  /** 도구 막대 (메모 옆) */
  toolstrip: object;
  /** 화면 위에 뜨는 창 */
  dialogs: object;
  /** 컬럼 타입 칸 오른쪽 */
  typeCell: { table: Table; column: Column; enums?: EnumType[]; unknownType: boolean };
  /** 컬럼 줄의 기본값 칸 옆 작은 버튼 */
  columnTools: { table: Table; column: Column; mark?: Mark; setColumn: (patch: Partial<Column>) => void };
  /** 편집 창의 테이블 아래 구역 (인덱스 다음) */
  tableSections: { table: Table };
  /** 인덱스 구역 머리의 추가 버튼 */
  indexHead: { table: Table };
  /** 인덱스 카드의 방식·조건 */
  indexOptions: { table: Table; index: Index };
}
export type SlotName = keyof SlotProps;

/** 기능 모듈 하나의 화면 조각들 (feature: 그 DB의 기능 모듈 — 예시 문구·방식 목록 등을 여기서 읽는다) */
export type FeatureSlots<F> = { [S in SlotName]?: ComponentType<SlotProps[S] & { feature: F }> };

/** 기능 모듈 → 화면 조각 */
const UI: { [K in FeatureKey]?: FeatureSlots<NonNullable<DialectFeatures[K]>> } = {
  enum: enumUi,
  check: checkUi,
  expressionIndex: expressionIndexUi,
  indexMethods: indexMethodsUi,
  partialIndex: partialIndexUi,
  generated: generatedUi,
  onUpdateTimestamp: onUpdateTimestampUi,
};

/** 프로젝트 DB의 기능 모듈 */
export function useFeatures(): DialectFeatures {
  return getDialect(useDialect()).features;
}

/** 이 자리에 그릴 화면 조각 (프로젝트 DB에 있는 기능만) */
export function useSlot<S extends SlotName>(name: S) {
  const features = useFeatures();
  return (Object.keys(UI) as FeatureKey[])
    .filter((k) => features[k] && UI[k]?.[name])
    .map((k) => ({ key: k, Component: UI[k]![name] as ComponentType<SlotProps[S] & { feature: unknown }>, feature: features[k] }));
}

/** 기능 모듈의 화면 조각을 그리는 자리 */
export function Slot<S extends SlotName>({ name, ...props }: { name: S } & SlotProps[S]) {
  const parts = useSlot(name);
  return (
    <>
      {parts.map(({ key, Component, feature }) => (
        <Component key={key} {...(props as unknown as SlotProps[S])} feature={feature} />
      ))}
    </>
  );
}
