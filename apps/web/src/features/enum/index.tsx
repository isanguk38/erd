// 사용자 정의 타입(ENUM) 기능의 화면 조각: 도구 막대 버튼, 타입 창, 컬럼 타입 칸 버튼.
// ENUM 모듈(features.enum)이 있는 DB의 프로젝트에서만 그려진다 (registry.tsx).

import { enumOfType, type EnumFeature } from '@erd/core';
import { useStore } from '../../store';
import { Icon } from '../../components/ui';
import type { FeatureSlots, SlotProps } from '../registry';
import { EnumDialog } from './EnumDialog';

/** 도구 막대 "타입" 버튼 */
function EnumToolbarButton() {
  const count = useStore((s) => s.schema.enums?.length ?? 0);
  return (
    <button className="btn btn-tool" onClick={() => useStore.getState().setEnumDialog({})} title="사용자 정의 타입(ENUM): 상태·구분처럼 값이 정해진 컬럼의 타입을 만들고 고칩니다">
      <Icon name="tag" />
      <span className="hide-narrow">타입{count ? ` ${count}` : ''}</span>
    </button>
  );
}

/** 타입 창 (도구 막대·타입 칸에서 연다) */
function EnumDialogHost({ feature }: { feature: EnumFeature }) {
  const open = useStore((s) => s.enumDialog);
  if (!open) return null;
  return <EnumDialog focus={open.focus} create={open.create} help={feature.help} onClose={() => useStore.getState().setEnumDialog(null)} />;
}

/**
 * 컬럼 타입 칸 오른쪽 작은 버튼: ENUM이면 그 타입의 값을 보고 고치는 창을 열고,
 * 목록에 없는 사용자 타입("Approve" 같은 따옴표 타입)이면 그 이름으로 타입을 만드는 창을 연다
 */
function EnumTypeButton({ column, enums, unknownType }: SlotProps['typeCell'] & { feature: EnumFeature }) {
  const type = column.type;
  const unknown = unknownType;
  const e = enumOfType(enums, type);
  // 따옴표 타입(PostgreSQL 사용자 타입)이거나, 이 DB가 모르는 이름 하나짜리 타입(직접 만든 타입일 수 있음)
  const custom = !e && (/^"[^"]+"$/.test(type.trim()) || (Boolean(unknown) && /^[A-Za-z_][\w$]*$/.test(type.trim())));
  if (!e && !custom) return null;
  const open = () => useStore.getState().setEnumDialog(e ? { focus: e.name } : { create: type.trim().replace(/"/g, '') });
  return (
    <button
      type="button"
      className={`type-cell__enum${e ? '' : ' missing'}`}
      onClick={open}
      title={e ? `ENUM ${e.name}: ${e.values.join(', ')}\n누르면 값을 보고 고칩니다` : `${type.trim()}은(는) 타입 목록에 없는 타입입니다 — 직접 만든 타입이면 누르고 값을 넣어 ENUM 타입으로 만드세요`}
      aria-label={e ? `${e.name} 타입 값 보기·고치기` : `${type.trim()} 타입 만들기`}
    >
      {e ? 'ENUM' : '+'}
    </button>
  );
}

export const enumUi: FeatureSlots<EnumFeature> = {
  toolstrip: EnumToolbarButton,
  dialogs: EnumDialogHost,
  typeCell: EnumTypeButton,
};
