// 인덱스 기능의 화면 조각.
// - 식 인덱스(expressionIndex): 인덱스 구역 머리의 "+ 식 인덱스" 버튼
// - 인덱스 방식(indexMethods): 인덱스 카드의 "방식" 고르기 (gin, FULLTEXT 등)
// - 부분 인덱스(partialIndex): 인덱스 카드의 "조건(WHERE)" 칸
// 각각 그 모듈이 있는 DB에서만 그려진다.

import { addIndex, updateIndex, type ExpressionIndexFeature, type IndexMethodFeature, type PartialIndexFeature } from '@erd/core';
import { useStore } from '../../store';
import { TextInput } from '../../components/TextInput';
import type { FeatureSlots, SlotProps } from '../registry';

function AddExpressionIndex({ table, feature }: SlotProps['indexHead'] & { feature: ExpressionIndexFeature }) {
  return (
    <button
      className="btn btn-sm"
      title={`컬럼 대신 식(함수)으로 만드는 인덱스. ${feature.hint}`}
      disabled={table.columns.length === 0}
      onClick={() => useStore.getState().edit((d) => addIndex(d, table.id, { columnIds: [], expression: feature.example(table.columns[0].name) }))}
    >
      + 식 인덱스
    </button>
  );
}

function IndexMethodSelect({ table, index, feature }: SlotProps['indexOptions'] & { feature: IndexMethodFeature }) {
  return (
    <label>
      <span>방식</span>
      <select value={index.method ?? ''} onChange={(e) => useStore.getState().edit((d) => updateIndex(d, table.id, index.id, { method: e.target.value || undefined }))}>
        <option value="">기본 (btree)</option>
        {[...new Set([...feature.methods, ...(index.method ? [index.method] : [])])].map((m) => (
          <option key={m} value={m}>{feature.label(m)}</option>
        ))}
      </select>
    </label>
  );
}

function PartialIndexWhere({ table, index, feature }: SlotProps['indexOptions'] & { feature: PartialIndexFeature }) {
  return (
    <label>
      <span>조건</span>
      <TextInput
        className="mono"
        value={index.where ?? ''}
        placeholder={feature.placeholder}
        onCommit={(where) => useStore.getState().edit((d) => updateIndex(d, table.id, index.id, { where: where.trim() || undefined }))}
      />
    </label>
  );
}

export const expressionIndexUi: FeatureSlots<ExpressionIndexFeature> = { indexHead: AddExpressionIndex };
export const indexMethodsUi: FeatureSlots<IndexMethodFeature> = { indexOptions: IndexMethodSelect };
export const partialIndexUi: FeatureSlots<PartialIndexFeature> = { indexOptions: PartialIndexWhere };
