import { copyTables, isClip, pasteTables, type Clip } from '@erd/core';
import { useStore } from '../store';

// 테이블 복사·붙여넣기. 시스템 클립보드에도 넣어 다른 프로젝트·다른 창에 붙여넣을 수 있게 한다.

let memory: Clip | null = null;
let pasteCount = 0;

function selectedTableIds(): string[] {
  const { selectedTables, selection } = useStore.getState();
  if (selectedTables.length) return selectedTables;
  return selection?.type === 'table' ? [selection.id] : [];
}

/** 고른 테이블을 복사한다. 복사한 테이블 수를 돌려준다 */
export function copySelection(): number {
  const ids = selectedTableIds();
  if (!ids.length) return 0;
  memory = copyTables(useStore.getState().schema, ids);
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

/** 붙여넣기. 붙일 때마다 조금씩 비켜서 놓고, 붙인 테이블을 골라 둔다 */
export async function pasteClipboard(): Promise<number> {
  const clip = await readClip();
  if (!clip?.tables.length) return 0;
  pasteCount += 1;
  let created: string[] = [];
  useStore.getState().edit((draft) => {
    created = pasteTables(draft, clip, { x: 40 * pasteCount, y: 40 * pasteCount });
  });
  if (created.length) useStore.getState().selectTables(created);
  return created.length;
}

export function selectAllTables(): void {
  const { schema, selectTables } = useStore.getState();
  selectTables(schema.tables.map((t) => t.id));
}
