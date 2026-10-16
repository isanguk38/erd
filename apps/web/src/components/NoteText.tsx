import { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * 공지·업데이트 글(마크다운)을 보여 준다: 제목, 굵게·기울임·취소선, 목록·체크리스트, 표, 인용, 코드, 구분선, 링크, 이미지(주소), 이모지.
 * 글에 HTML이나 스크립트를 넣어도 실행되지 않게 걸러서 보여 준다 (관리자 계정이 털려도 사용자 화면이 위험해지지 않게).
 * 앱 업데이트 창·새 소식·관리자 페이지 미리보기에서 함께 쓴다.
 */
const marked = new Marked({ gfm: true, breaks: true });

let hooked = false;
function sanitize(html: string): string {
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
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span'],
    ALLOWED_ATTR: ['href', 'title', 'alt', 'src', 'align', 'type', 'checked', 'disabled', 'start'],
  });
  // 주소가 걸러진(http(s)가 아닌) 이미지는 깨진 그림으로 남지 않게 뺀다
  return clean.replace(/<img(?![^>]*\ssrc=)[^>]*>/g, '');
}

export function NoteText({ text, empty = '내용이 없습니다.' }: { text: string; empty?: string }) {
  const html = useMemo(() => (text.trim() ? sanitize(marked.parse(text, { async: false }) as string) : ''), [text]);
  if (!html) return <div className="release-notes md"><p className="muted">{empty}</p></div>;
  return <div className="release-notes md" dangerouslySetInnerHTML={{ __html: html }} />;
}
