// DB 객체(뷰·함수·프로시저·트리거·이벤트·패키지) 기능의 화면 조각: 도구 막대 버튼, 객체 창.
// objects 모듈(features.objects)이 있는 DB의 프로젝트에서만 그려진다 (registry.tsx). 종류는 DB마다 다르다.

import type { DbObjectsFeature } from '@erd/core';
import { useStore } from '../../store';
import { Icon } from '../../components/ui';
import type { FeatureSlots } from '../registry';
import { ObjectsDialog } from './ObjectsDialog';

/** 도구 막대 "객체" 버튼 */
function ObjectsToolbarButton() {
  const count = useStore((s) => s.schema.objects?.length ?? 0);
  return (
    <button className="btn btn-tool" onClick={() => useStore.getState().setObjectsDialog({})} title="DB 객체: 뷰·함수·프로시저·트리거 등을 DDL로 보고 고칩니다 (DB로 내보내기로 반영)">
      <Icon name="code" />
      <span className="hide-narrow">객체{count ? ` ${count}` : ''}</span>
    </button>
  );
}

function ObjectsDialogHost({ feature }: { feature: DbObjectsFeature }) {
  const open = useStore((s) => s.objectsDialog);
  if (!open) return null;
  return <ObjectsDialog feature={feature} focus={open.focus} onClose={() => useStore.getState().setObjectsDialog(null)} />;
}

export const objectsUi: FeatureSlots<DbObjectsFeature> = {
  toolstrip: ObjectsToolbarButton,
  dialogs: ObjectsDialogHost,
};
