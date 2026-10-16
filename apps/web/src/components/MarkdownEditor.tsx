// 관리자 글쓰기: 꾸미기 버튼(제목·굵게·목록·표·링크·이미지·이모지 …)이 마크다운을 넣어 주고, 옆에서 바로 실제 모양을 본다.
// 넓은 화면은 쓰기|미리보기 두 칸, 좁은 화면은 탭으로.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NoteText } from './NoteText';

const EMOJIS = ['📢', '🎉', '✨', '🚀', '✅', '⚠️', '❗', '🔧', '🛠️', '🐛', '💡', '📌', '📝', '📦', '🔒', '⏰', '🗓️', '👍', '🙏', '❤️', '🔥', '⭐', '➡️', '⬆️', '🆕', '💾', '🧪', '📊', '🔗', '📣', '😊', '😅', '🙇', '👀', '🎁', '🛑'];

type Edit = (sel: string) => { text: string; select?: [number, number] };

export function MarkdownEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = (e: MouseEvent) => !emojiRef.current?.contains(e.target as Node) && setEmojiOpen(false);
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [emojiOpen]);

  // 버튼으로 바꾼 뒤 둘 커서·선택: 글이 다시 그려진 바로 뒤에 둔다 (창이 가려져 있어도 되게 requestAnimationFrame은 쓰지 않음)
  const pendingSelection = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    const sel = pendingSelection.current;
    if (!ta || !sel) return;
    pendingSelection.current = null;
    ta.focus();
    ta.setSelectionRange(sel[0], sel[1]);
  }, [value]);

  /** 고른 글자를 바꿔 넣고 커서·선택을 다시 둔다 */
  const apply = (edit: Edit) => {
    const ta = ref.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const { text, select } = edit(value.slice(start, end));
    const [a, b] = select ?? [text.length, text.length];
    pendingSelection.current = [start + a, start + b];
    onChange(value.slice(0, start) + text + value.slice(end));
  };
  const wrap = (mark: string, placeholder: string): Edit => (sel) => {
    const inner = sel || placeholder;
    return { text: `${mark}${inner}${mark}`, select: [mark.length, mark.length + inner.length] };
  };
  /** 고른 줄마다 앞에 붙이기 (줄 처음부터) */
  const linePrefix = (prefix: (i: number) => string, placeholder: string) => {
    const ta = ref.current;
    if (!ta) return;
    const lineStart = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    ta.setSelectionRange(lineStart, ta.selectionEnd);
    apply((sel) => {
      const lines = (sel || placeholder).split('\n');
      const text = lines.map((l, i) => `${prefix(i)}${l}`).join('\n');
      return { text, select: [text.length, text.length] };
    });
  };
  const block = (snippet: string, selectFrom?: number, selectTo?: number): Edit => () => {
    const ta = ref.current!;
    const before = value.slice(0, ta.selectionStart);
    const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const text = `${lead}${snippet}\n`;
    return { text, select: selectFrom !== undefined ? [lead.length + selectFrom, lead.length + (selectTo ?? selectFrom)] : undefined };
  };

  const TABLE = '| 항목 | 내용 | 비고 |\n| --- | --- | --- |\n| 예시 | 설명 | |\n| | | |';
  const tools: { label: string; title: string; run: () => void; className?: string }[] = [
    { label: 'H', title: '제목 (## )', run: () => linePrefix(() => '## ', '제목') },
    { label: 'B', title: '굵게 (Ctrl+B)', run: () => apply(wrap('**', '굵은 글자')), className: 'b' },
    { label: 'I', title: '기울임 (Ctrl+I)', run: () => apply(wrap('*', '기울인 글자')), className: 'i' },
    { label: 'S', title: '취소선', run: () => apply(wrap('~~', '지운 글자')), className: 's' },
    { label: '•', title: '목록', run: () => linePrefix(() => '- ', '항목') },
    { label: '1.', title: '번호 목록', run: () => linePrefix((i) => `${i + 1}. `, '항목') },
    { label: '☑', title: '체크리스트', run: () => linePrefix(() => '- [ ] ', '할 일') },
    { label: '❝', title: '인용', run: () => linePrefix(() => '> ', '인용') },
    { label: '</>', title: '코드', run: () => apply(wrap('`', 'code')) },
    { label: '표', title: '표 넣기 (3칸)', run: () => apply(block(TABLE, 2, 4)) },
    { label: '—', title: '구분선', run: () => apply(block('---')) },
    { label: '🔗', title: '링크', run: () => apply((sel) => ({ text: `[${sel || '링크 글자'}](https://)`, select: [(sel || '링크 글자').length + 3, (sel || '링크 글자').length + 11] })) },
    { label: '🖼', title: '이미지 (주소)', run: () => apply(block('![이미지 설명](https://)', 9, 17)) },
  ];

  const insertEmoji = (e: string) => {
    apply(() => ({ text: e }));
    setEmojiOpen(false);
  };

  return (
    <div className={`md-editor tab-${tab}`}>
      <div className="md-editor__bar" role="toolbar" aria-label="꾸미기">
        {tools.map((t) => (
          <button key={t.title} type="button" className={`md-tool ${t.className ?? ''}`} title={t.title} aria-label={t.title} onClick={t.run}>{t.label}</button>
        ))}
        <div className="md-emoji" ref={emojiRef}>
          <button type="button" className="md-tool" title="이모지" aria-label="이모지" onClick={() => setEmojiOpen(!emojiOpen)}>😀</button>
          {emojiOpen && (
            <div className="md-emoji__menu" role="menu">
              {EMOJIS.map((e) => <button key={e} type="button" onClick={() => insertEmoji(e)}>{e}</button>)}
            </div>
          )}
        </div>
        <span className="md-editor__tabs">
          <button type="button" className={tab === 'write' ? 'active' : ''} onClick={() => setTab('write')}>쓰기</button>
          <button type="button" className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>미리보기</button>
        </span>
      </div>
      <div className="md-editor__panes">
        <textarea
          ref={ref}
          className="admin-body md-editor__input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); apply(wrap('**', '굵은 글자')); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); apply(wrap('*', '기울인 글자')); }
          }}
          placeholder={'## 🎉 새 기능\n- **테스트 데이터**: 큰 ERD에서도 바로 열립니다\n- 헤더 디자인 정리\n\n| 항목 | 내용 |\n| --- | --- |\n| 버전 | 0.2.9 |'}
        />
        <div className="md-editor__preview admin-preview" aria-label="미리보기">
          <NoteText text={value} empty="여기에 실제 모양이 보입니다." />
        </div>
      </div>
    </div>
  );
}
