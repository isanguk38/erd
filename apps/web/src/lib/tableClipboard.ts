import { addToArea, areaSchema, copyTables, isClip, pasteTables, removeFromArea, type Clip, type Schema } from '@erd/core';
import { useStore } from '../store';

// 테이블 복사·붙여넣기. 시스템 클립보드에도 넣어 다른 프로젝트·다른 창에 붙여넣을 수 있게 한다.

let memory: Clip | null = null;
let pasteCount = 0;

/** 지금 보이는 스키마: 영역 탭이면 영역 위치로 (복사·붙여넣기·전체 선택이 화면에 보이는 대로 동작하게) */
function visibleSchema(): { schema: Schema; areaId: string | null } {
  const { schema, activeArea } = useStore.getState();
  const area = activeArea ? schema.areas?.find((a) => a.id === activeArea) : undefined;
  return area ? { schema: { ...areaSchema(schema, area.id).schema, relations: schema.relations }, areaId: area.id } : { schema, areaId: null };
}

function selectedTableIds(): string[] {
  const { selectedTables, selection } = useStore.getState();
  if (selectedTables.length) return selectedTables;
  return selection?.type === 'table' ? [selection.id] : [];
}

/** 고른 테이블을 복사한다. 복사한 테이블 수를 돌려준다 */
export function copySelection(): number {
  const ids = selectedTableIds();
  if (!ids.length) return 0;
  memory = copyTables(visibleSchema().schema, ids.filter((id) => visibleSchema().schema.tables.some((t) => t.id === id)));
  if (!memory.tables.length) return 0;
  pasteCount = 0;
  navigator.clipboard?.writeText(JSON.stringify(memory)).catch(() => {
    /* 권한이 없으면 이 창 안에서만 붙여넣기 */
  });
  return ids.length;
}

async function readClip(): Promise<Clip | null> {
  try {
    const text = await navigator.clipboard?.readText();
    if (text && text.includes('"erd-tables"')) {
      const parsed = JSON.parse(text);
      if (isClip(parsed)) {
        if (!memory || JSON.stringify(memory) !== text) pasteCount = 0;
        memory = parsed;
      }
    }
  } catch {
    /* 클립보드를 못 읽으면 이 창에서 복사한 것을 쓴다 */
  }
  return memory;
}

/**
 * 붙여넣기. 붙일 때마다 조금씩 비켜서 놓고, 붙인 테이블을 골라 둔다.
 * 주제영역 탭에서 이 ERD의 테이블을 붙이면 복사본 대신 같은 테이블을 이 영역에 넣는다 (관계도 그대로 이어짐).
 * copy=true(Ctrl+Shift+V)면 언제나 복사본을 만든다.
 */
export async function pasteClipboard(copy = false): Promise<number> {
  const clip = await readClip();
  if (!clip?.tables.length) return 0;
  if (!copy && addSameTablesToArea(clip)) return clip.tables.length;
  pasteCount += 1;
  let created: string[] = [];
  const { areaId } = visibleSchema();
  useStore.getState().edit((draft) => {
    created = pasteTables(draft, clip, { x: 40 * pasteCount, y: 40 * pasteCount });
    // 영역 탭에서 붙이면 그 영역에 (붙인 자리 그대로) 넣는다
    if (areaId && draft.areas?.some((a) => a.id === areaId)) {
      const positions = Object.fromEntries(created.map((id) => [id, draft.tables.find((t) => t.id === id)!.position]));
      addToArea(draft, areaId, created, positions);
    }
  });
  if (created.length) useStore.getState().selectTables(created);
  return created.length;
}

/** 영역 탭에서 이 ERD의 테이블을 붙였으면 같은 테이블을 이 영역에 넣는다. 넣었으면 true */
function addSameTablesToArea(clip: Clip): boolean {
  const { schema, activeArea, edit, selectTables, showNotice } = useStore.getState();
  const area = activeArea ? schema.areas?.find((a) => a.id === activeArea) : undefined;
  if (!area) return false;
  const ids = clip.tables.map((t) => t.id);
  // 모두 이 ERD에 있는 테이블이고, 이 영역에 아직 없는 것이 있을 때만 (이미 다 있으면 복사본을 원하는 것)
  if (!ids.every((id) => schema.tables.some((t) => t.id === id))) return false;
  const missing = ids.filter((id) => !area.tableIds.includes(id));
  if (!missing.length) return false;
  edit((d) => void addToArea(d, area.id, missing));
  selectTables(missing);
  const names = missing.map((id) => schema.tables.find((t) => t.id === id)!.name).join(', ');
  showNotice({
    text: `${names}을(를) ${area.name} 영역에 넣었습니다 — 복사본이 아니라 같은 테이블이라 관계도 그대로 이어집니다`,
    action: {
      label: '복사본 만들기',
      run: () => {
        useStore.getState().edit((d) => removeFromArea(d, area.id, missing));
        void pasteClipboard(true);
      },
    },
  });
  return true;
}

export function selectAllTables(): void {
  // 영역 탭이면 그 영역 테이블만
  useStore.getState().selectTables(visibleSchema().schema.tables.map((t) => t.id));
}
