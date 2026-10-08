import { memo, useCallback, useEffect, useState } from 'react';
import { NodeResizer, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { NOTE_COLORS, NOTE_MIN } from '@erd/core';
import { useStore } from '../store';
import { takeFocus } from '../lib/focus';

/** 캔버스 메모 (포스트잇). 더블클릭으로 내용 고치기, 고르면 크기 조절·색·삭제 */
export type NoteNodeData = {
  text: string;
  color?: string;
  readOnly: boolean;
};
export type NoteNodeType = Node<NoteNodeData, 'note'>;

const COLOR_NAMES = ['노랑', '파랑', '초록', '분홍', '보라', '회색'];

function NoteNodeView({ id, data, selected }: NodeProps<NoteNodeType>) {
  const [draft, setDraft] = useState<string | null>(null);
  const { updateNote, removeNotes } = useStore.getState();
  const editing = draft !== null && !data.readOnly;
  // 방금 만든 메모면 바로 입력
  useEffect(() => {
    if (!data.readOnly && takeFocus(`note:${id}`)) setDraft(data.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const textareaRef = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const commit = () => {
    if (draft !== null && draft !== data.text) updateNote(id, { text: draft });
    setDraft(null);
  };
  return (
    <div
      className={`note-node${selected ? ' selected' : ''}`}
      style={{ background: data.color || NOTE_COLORS[0] }}
      onDoubleClick={(e) => {
        if (data.readOnly) return;
        e.stopPropagation();
        setDraft(data.text);
      }}
      title={data.readOnly ? undefined : '더블클릭해 내용 고치기'}
    >
      {!data.readOnly && (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={NOTE_MIN.width}
          minHeight={NOTE_MIN.height}
          lineClassName="note-node__resize-line"
          handleClassName="note-node__resize-handle"
          onResizeEnd={(_, p) => updateNote(id, { position: { x: p.x, y: p.y }, width: p.width, height: p.height })}
        />
      )}
      {!data.readOnly && (
        <NodeToolbar isVisible={selected && !editing} position={Position.Top} className="note-toolbar">
          {NOTE_COLORS.map((c, i) => (
            <button
              key={c}
              className={`note-toolbar__color${(data.color || NOTE_COLORS[0]) === c ? ' active' : ''}`}
              style={{ background: c }}
              title={COLOR_NAMES[i]}
              onClick={() => updateNote(id, { color: c })}
            />
          ))}
          <span className="note-toolbar__sep" />
          <button className="note-toolbar__btn" onClick={() => setDraft(data.text)}>고치기</button>
          <button className="note-toolbar__btn danger" onClick={() => removeNotes([id])} title="메모 삭제 (Delete 키)">삭제</button>
        </NodeToolbar>
      )}
      {editing ? (
        <textarea
          ref={textareaRef}
          className="note-node__input nodrag nowheel nopan"
          value={draft ?? ''}
          placeholder="메모 내용 (Ctrl+Enter 또는 바깥을 누르면 저장, Esc 취소)"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setDraft(null);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
          }}
        />
      ) : (
        <div className="note-node__text">
          {data.text.trim() ? (
            // 줄마다 따로 그린다 (이미지 내보내기가 줄 단위로 글자를 옮긴다)
            data.text.split('\n').map((line, i) => <div key={i} className="note-node__line">{line || ' '}</div>)
          ) : (
            <div className="note-node__placeholder">{data.readOnly ? '' : '더블클릭해 메모 입력'}</div>
          )}
        </div>
      )}
    </div>
  );
}

export const NoteNode = memo(NoteNodeView);
