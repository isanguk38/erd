import { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 공지·업데이트 글을 보여 준다. 새 글은 HTML(관리자 편집기에서 쓴 글), 예전 글·GitHub 릴리스 설명은 마크다운.
 * 어느 쪽이든 위험한 태그·스크립트·이벤트 속성은 걸러서 보여 준다 (관리자 계정이 털려도 사용자 화면이 위험해지지 않게).
 * 앱 업데이트 창·새 소식·관리자 페이지 미리보기에서 함께 쓴다.
 */
const marked = new Marked({ gfm: true, breaks: true });

export type NoteFormat = 'html' | 'markdown';

let hooked = false;
export function sanitizeNoteHtml(html: string): string {
  if (!hooked) {
    hooked = true;
    // 링크는 새 창으로 (설치형 앱에서는 기본 브라우저로 열린다), 이미지·링크는 http(s)만
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute('href');
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
      if (node.tagName === 'IMG') {
        const src = node.getAttribute('src') ?? '';
        if (!/^https?:/i.test(src)) node.removeAttribute('src');
        node.setAttribute('loading', 'lazy');
      }
      // 체크리스트 칸은 보기만
      if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
    });
  }
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'del', 's', 'mark', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'img', 'table', 'colgroup', 'col', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'label', 'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'align', 'type', 'checked', 'disabled', 'start', 'colspan', 'rowspan'],
    // 체크리스트 모양(data-type·data-checked)은 남긴다 (data-* 속성은 실행되지 않음)
    ALLOW_DATA_ATTR: true,
  });
  // 주소가 걸러진(http(s)가 아닌) 이미지는 깨진 그림으로 남지 않게 뺀다
  return clean.replace(/<img(?![^>]*\ssrc=)[^>]*>/g, '');
}

/** 마크다운(예전 글) → HTML (편집기로 옮길 때도 쓴다) */
export const markdownToHtml = (text: string) => marked.parse(text, { async: false }) as string;

export function NoteText({ text, format = 'markdown', empty = '내용이 없습니다.' }: { text: string; format?: NoteFormat; empty?: string }) {
  const html = useMemo(() => {
    if (!text.trim()) return '';
    const clean = sanitizeNoteHtml(format === 'html' ? text : markdownToHtml(text));
    // 빈 문단만 있는 글(편집기에서 다 지운 경우)은 비어 있는 것으로
    return clean.replace(/<p>\s*<\/p>/g, '').trim() ? clean : '';
  }, [text, format]);
  if (!html) return <div className="release-notes md"><p className="muted">{empty}</p></div>;
  return <div className="release-notes md" dangerouslySetInnerHTML={{ __html: html }} />;
}
