// 관리자 글쓰기: 보이는 그대로 편집(표를 편집 칸에서 바로 만들고 고치기) · HTML(코드로 보고 고치기·붙여넣기) · 미리보기(사용자에게 보일 모양).
// 저장 형식은 HTML. 편집기 라이브러리(TipTap)가 커서 관리자 페이지에서만 불러온다 (AdminPage에서 lazy).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { NoteText } from './NoteText';
import { Icon } from './ui';

const EMOJIS = ['📢', '🎉', '✨', '🚀', '✅', '⚠️', '❗', '🔧', '🛠️', '🐛', '💡', '📌', '📝', '📦', '🔒', '⏰', '🗓️', '👍', '🙏', '❤️', '🔥', '⭐', '➡️', '⬆️', '🆕', '💾', '🧪', '📊', '🔗', '📣', '😊', '😅', '🙇', '👀', '🎁', '🛑'];

type Mode = 'edit' | 'html' | 'preview';

/**
 * 편집기 내용 (HTML). 빈 줄 하나뿐일 때만 빈 글로 본다.
 * (editor.isEmpty는 글자가 없으면 참이라, 빈 칸뿐인 표·구분선·이미지만 넣은 글을 빈 글로 잘못 본다)
 */
function htmlOf(editor: Editor): string {
  if (editor.isDestroyed) return '';
  const doc = editor.state.doc;
  const blank = doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph' && doc.firstChild.content.size === 0;
  return blank ? '' : editor.getHTML();
}

/** HTML 칸에서 읽기 쉽게: 문단·표·목록 단위로 줄을 나눈다 (보이는 모양은 그대로) */
function prettyHtml(html: string): string {
  return html
    .replace(/(<\/(p|h[1-6]|li|ul|ol|table|thead|tbody|tr|blockquote|div)>)(?!\n)/g, '$1\n')
    .replace(/(<(ul|ol|table|thead|tbody|tr|blockquote)( [^>]*)?>)(?!\n)/g, '$1\n')
    .replace(/(<hr ?\/?>)(?!\n)/g, '$1\n')
    .trim();
}

export function RichEditor({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const [mode, setMode] = useState<Mode>('edit');
  const [htmlDraft, setHtmlDraft] = useState('');
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        link: { openOnClick: false, autolink: true },
      }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Image.configure({ inline: false }),
      // 왼쪽·가운데·오른쪽·양쪽 맞춤 (문단·제목, 표 칸 안 글자도)
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: value,
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor: e }) => onChange(htmlOf(e)),
  });

  // 다른 글을 고르면(바깥에서 value가 바뀌면) 편집기 내용도 바꾼다
  const lastEmitted = useRef(value);
  useEffect(() => {
    // 화면이 다시 붙을 때(React가 효과를 다시 돌릴 때) 이미 닫힌 편집기는 건드리지 않는다
    if (!editor || editor.isDestroyed) return;
    const current = htmlOf(editor);
    if (value !== current && value !== lastEmitted.current) editor.commands.setContent(value || '', { emitUpdate: false });
    lastEmitted.current = value;
  }, [value, editor]);

  const switchMode = (next: Mode) => {
    if (next === mode || !editor || editor.isDestroyed) return;
    if (next === 'html') setHtmlDraft(prettyHtml(value));
    if (mode === 'html' && next !== 'html') {
      // HTML 칸에서 고친 내용을 편집기로 (편집기가 모르는 태그는 정리된다)
      editor.commands.setContent(htmlDraft, { emitUpdate: false });
      onChange(htmlDraft.trim() ? htmlOf(editor) : '');
    }
    setMode(next);
  };

  return (
    <div className={`rich-editor mode-${mode}`}>
      <div className="rich-editor__bar">
        {mode === 'edit' && editor ? <Toolbar editor={editor} /> : <span className="muted small rich-editor__hint">{mode === 'html' ? 'HTML을 직접 고치거나 붙여 넣을 수 있습니다. "편집"으로 돌아가면 편집기가 다룰 수 없는 태그는 정리됩니다.' : '사용자에게 보이는 모양입니다.'}</span>}
        <span className="rich-editor__modes" role="tablist">
          {(['edit', 'html', 'preview'] as Mode[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => switchMode(m)}>
              {m === 'edit' ? '편집' : m === 'html' ? 'HTML' : '미리보기'}
            </button>
          ))}
        </span>
      </div>
      {editor && editor.isActive('table') && mode === 'edit' && <TableBar editor={editor} />}
      <div className="rich-editor__body">
        {mode === 'edit' && <EditorContent editor={editor} className="rich-editor__content release-notes md" />}
        {mode === 'html' && (
          <textarea
            className="rich-editor__html"
            value={htmlDraft}
            spellCheck={false}
            onChange={(e) => {
              setHtmlDraft(e.target.value);
              onChange(e.target.value);
            }}
            aria-label="HTML"
          />
        )}
        {mode === 'preview' && <div className="rich-editor__preview"><NoteText text={value} format="html" empty="아직 내용이 없습니다." /></div>}
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // 이모지 판은 화면 기준 위치(편집 칸 밖으로 나가도 잘리지 않게, 오른쪽 끝이면 왼쪽으로 당김)
  const [emojiAt, setEmojiAt] = useState<{ top: number; left: number } | null>(null);
  const emojiOpen = emojiAt !== null;
  const emojiRef = useRef<HTMLDivElement>(null);
  const toggleEmoji = () => {
    if (emojiOpen) return setEmojiAt(null);
    const r = emojiRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 9 * 30 + 8 * 2 + 14; // 9칸 + 간격 + 안쪽 여백·테두리
    setEmojiAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  };
  const setEmojiOpen = (open: boolean) => !open && setEmojiAt(null);
  useEffect(() => {
    if (!emojiOpen) return;
    const close = (e: MouseEvent) => !emojiRef.current?.contains(e.target as Node) && setEmojiOpen(false);
    // 스크롤·창 크기가 바뀌면 위치가 어긋나니 닫는다
    const dismiss = () => setEmojiOpen(false);
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emojiOpen]);
  const chain = () => editor.chain().focus();
  const btn = (label: ReactNode, title: string, run: () => void, active = false, className = '') => (
    <button type="button" className={`md-tool ${className}${active ? ' active' : ''}`} title={title} aria-label={title} aria-pressed={active} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {label}
    </button>
  );
  const block = editor.isActive('heading', { level: 2 }) ? 'h2' : editor.isActive('heading', { level: 3 }) ? 'h3' : editor.isActive('heading', { level: 4 }) ? 'h4' : 'p';
  const link = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('링크 주소 (https://…, 비우면 링크 해제)', prev ?? 'https://');
    if (url === null) return;
    if (!url.trim() || url.trim() === 'https://') chain().extendMarkRange('link').unsetLink().run();
    else chain().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const image = () => {
    const url = window.prompt('이미지 주소 (https://…)', 'https://');
    if (url && /^https?:\/\/.+/i.test(url.trim())) chain().setImage({ src: url.trim() }).run();
  };
  return (
    <span className="rich-toolbar" role="toolbar" aria-label="꾸미기">
      <select
        className="rich-toolbar__block"
        value={block}
        title="문단 모양"
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'p') chain().setParagraph().run();
          else chain().setHeading({ level: Number(v.slice(1)) as 2 | 3 | 4 }).run();
        }}
      >
        <option value="p">본문</option>
        <option value="h2">큰 제목</option>
        <option value="h3">중간 제목</option>
        <option value="h4">작은 제목</option>
      </select>
      {btn('B', '굵게 (Ctrl+B)', () => chain().toggleBold().run(), editor.isActive('bold'), 'b')}
      {btn('I', '기울임 (Ctrl+I)', () => chain().toggleItalic().run(), editor.isActive('italic'), 'i')}
      {btn('U', '밑줄 (Ctrl+U)', () => chain().toggleUnderline().run(), editor.isActive('underline'), 'u')}
      {btn('S', '취소선', () => chain().toggleStrike().run(), editor.isActive('strike'), 's')}
      <span className="rich-toolbar__sep" />
      {btn(<Icon name="alignLeft" size={14} />, '왼쪽 맞춤', () => chain().setTextAlign('left').run(), editor.isActive({ textAlign: 'left' }), 'align')}
      {btn(<Icon name="alignCenter" size={14} />, '가운데 맞춤', () => chain().setTextAlign('center').run(), editor.isActive({ textAlign: 'center' }), 'align')}
      {btn(<Icon name="alignRight" size={14} />, '오른쪽 맞춤', () => chain().setTextAlign('right').run(), editor.isActive({ textAlign: 'right' }), 'align')}
      {btn(<Icon name="alignJustify" size={14} />, '양쪽 맞춤', () => chain().setTextAlign('justify').run(), editor.isActive({ textAlign: 'justify' }), 'align')}
      <span className="rich-toolbar__sep" />
      {btn('•', '목록', () => chain().toggleBulletList().run(), editor.isActive('bulletList'))}
      {btn('1.', '번호 목록', () => chain().toggleOrderedList().run(), editor.isActive('orderedList'))}
      {btn('☑', '체크리스트', () => chain().toggleTaskList().run(), editor.isActive('taskList'))}
      {btn('❝', '인용', () => chain().toggleBlockquote().run(), editor.isActive('blockquote'))}
      {btn('</>', '코드 블록', () => chain().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
      {btn('—', '구분선', () => chain().setHorizontalRule().run())}
      <span className="rich-toolbar__sep" />
      {btn('표', '표 넣기 (3×3, 첫 줄 머리글)', () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), false, 'table')}
      {btn('🔗', '링크', link, editor.isActive('link'))}
      {btn('🖼', '이미지 (주소)', image)}
      <span className="md-emoji" ref={emojiRef}>
        {btn('😀', '이모지', toggleEmoji)}
        {emojiAt && (
          <span className="md-emoji__menu" role="menu" style={{ top: emojiAt.top, left: emojiAt.left }}>
            {EMOJIS.map((e) => (
              <button key={e} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => { chain().insertContent(e).run(); setEmojiOpen(false); }}>{e}</button>
            ))}
          </span>
        )}
      </span>
      {btn('↶', '되돌리기 (Ctrl+Z)', () => chain().undo().run())}
      {btn('↷', '다시 (Ctrl+Y)', () => chain().redo().run())}
    </span>
  );
}

/** 커서가 표 안에 있을 때: 행·열 넣기·빼기, 머리줄, 칸 합치기·나누기, 표 지우기 */
function TableBar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();
  const items: [string, () => boolean, boolean?][] = [
    ['위에 행', () => chain().addRowBefore().run()],
    ['아래에 행', () => chain().addRowAfter().run()],
    ['왼쪽에 열', () => chain().addColumnBefore().run()],
    ['오른쪽에 열', () => chain().addColumnAfter().run()],
    ['행 지우기', () => chain().deleteRow().run()],
    ['열 지우기', () => chain().deleteColumn().run()],
    ['머리줄 켜기/끄기', () => chain().toggleHeaderRow().run()],
    ['칸 합치기/나누기', () => chain().mergeOrSplit().run()],
    ['표 지우기', () => chain().deleteTable().run(), true],
  ];
  return (
    <div className="rich-tablebar" role="toolbar" aria-label="표 편집">
      <span className="muted small">표:</span>
      {items.map(([label, run, danger]) => (
        <button key={label} type="button" className={`btn btn-sm${danger ? ' btn-danger' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={run}>{label}</button>
      ))}
    </div>
  );
}
