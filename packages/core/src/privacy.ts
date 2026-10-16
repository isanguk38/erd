// 개인정보 컬럼 표시: 이름·전화번호·주민등록번호·계좌처럼 개인정보를 담는 컬럼에 종류와 암호화 여부를 적는다.
// ERD에만 저장하는 정보라 SQL·DB 비교에는 영향이 없다. 설계 검사(lint.ts)가 이름으로 개인정보로 보이는 컬럼을 찾아 표시를 권하고,
// 암호화해야 하는 종류(고유식별정보·비밀번호·계좌·카드)인데 암호화 표시가 없으면 알린다. 정의서에는 "개인정보 항목" 시트로 나간다.

import type { Column, Schema, Table } from './model';

/**
 * 개인정보 종류 (개인정보 보호법 기준)
 * - unique: 고유식별정보 — 주민등록번호·여권번호·운전면허번호·외국인등록번호 (암호화 의무)
 * - password: 비밀번호 — 일방향 암호화(해시) 의무
 * - financial: 금융정보 — 계좌번호·카드번호 (암호화 의무)
 * - sensitive: 민감정보 — 건강·장애·종교·범죄경력 등 (별도 동의, 암호화 권장)
 * - personal: 일반 개인정보 — 이름·연락처·이메일·주소·생년월일·IP
 */
export type PrivacyKind = 'unique' | 'password' | 'financial' | 'sensitive' | 'personal';

export interface ColumnPrivacy {
  kind: PrivacyKind;
  /** DB에 암호화(비밀번호는 해시)해서 저장하는지 */
  encrypted?: boolean;
}

export const PRIVACY_KINDS: PrivacyKind[] = ['unique', 'password', 'financial', 'sensitive', 'personal'];

export const PRIVACY_LABEL: Record<PrivacyKind, string> = {
  unique: '고유식별정보',
  password: '비밀번호',
  financial: '금융정보',
  sensitive: '민감정보',
  personal: '개인정보',
};

export const PRIVACY_HINT: Record<PrivacyKind, string> = {
  unique: '주민등록번호·여권번호·운전면허번호·외국인등록번호 — 암호화해서 저장해야 합니다',
  password: '비밀번호 — 일방향 암호화(해시)해서 저장해야 합니다',
  financial: '계좌번호·카드번호 — 암호화해서 저장해야 합니다',
  sensitive: '건강·장애·종교·범죄경력 등 — 별도 동의가 필요하고 암호화를 권장합니다',
  personal: '이름·연락처·이메일·주소·생년월일·IP 등',
};

/** 암호화(비밀번호는 해시)가 법으로 정해진 종류 */
export const PRIVACY_MUST_ENCRYPT: ReadonlySet<PrivacyKind> = new Set(['unique', 'password', 'financial']);

/** 화면·정의서에 쓰는 짧은 표시 (예: "고유식별정보 · 암호화") */
export function privacyText(p: ColumnPrivacy): string {
  return `${PRIVACY_LABEL[p.kind]}${p.encrypted ? ' · 암호화' : ''}`;
}

/** 저장된 값이 올바른 개인정보 표시인지 (MCP·붙여넣기로 들어온 값 검사) */
export function isPrivacyKind(value: unknown): value is PrivacyKind {
  return typeof value === 'string' && (PRIVACY_KINDS as string[]).includes(value);
}

// ── 이름으로 찾기 ────────────────────────────────
// 물리명은 단어(_ 또는 camelCase 경계)로 나눠 보고, 논리명은 한글 그대로 본다.
// 상품명·회사 전화처럼 사람이 아닌 것도 걸릴 수 있어, 찾은 것은 "표시를 권함"(참고)으로만 알리고 사람이 정한다.

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

interface Pattern {
  kind: PrivacyKind;
  /** 물리명 전체(소문자, _로 이은 것)에 대한 식 */
  physical?: RegExp;
  /** 논리명(한글)에 대한 식 */
  logical?: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: 'unique', physical: /(^|_)(rrn|ssn|jumin(_?no)?|resident_?(reg(istration)?_?)?(no|num(ber)?)|passport(_?(no|num(ber)?))?|driver_?licen[cs]e(_?(no|num(ber)?))?|licen[cs]e_?(no|num(ber)?)|alien_?reg(istration)?(_?(no|num(ber)?))?|foreigner_?(reg_?)?(no|num(ber)?))(_|$)/, logical: /주민(등록)?번호|여권\s*번호|운전\s*면허\s*번호|외국인\s*등록\s*번호/ },
  { kind: 'password', physical: /(^|_)(password|passwd|pwd|pw|pass_?word|pin_?(no|num(ber)?)?)(_|$)/, logical: /비밀\s*번호|패스워드|암호$/ },
  { kind: 'financial', physical: /(^|_)((bank_?)?(account|acct|acnt)_?(no|num(ber)?)|bank_?account|card_?(no|num(ber)?)|credit_?card(_?(no|num(ber)?))?|cvc|cvv)(_|$)/, logical: /계좌\s*번호|카드\s*번호|신용\s*카드|CVC|CVV/i },
  { kind: 'sensitive', physical: /(^|_)(health|medical|disease|diagnosis|disability|religion|criminal|crime|genetic|blood_?type|union_?member(ship)?|political)(_|$)/, logical: /건강|병력|질병|진단|장애|종교|신념|범죄|전과|유전|혈액형|노조|정당|성생활/ },
  {
    kind: 'personal',
    physical:
      /(^|_)((user|member|mbr|cust(omer)?|real|full|first|last|person|emp(loyee)?|buyer|receiver|recipient|sender|owner|holder|guardian|parent)_?(name|nm)|phone(_?(no|num(ber)?))?|mobile(_?(no|num(ber)?))?|cell(_?phone)?(_?(no|num(ber)?))?|hp(_?no)?|tel(_?(no|num(ber)?))?|telephone|e_?mail(_?addr(ess)?)?|(home_?|post(al)?_?|street_?|detail_?)?addr(ess)?(1|2|_?detail)?|zip(_?code)?|post(al)?_?code|birth(_?(day|date|dt|ymd))?|birthday|dob|ip(_?addr(ess)?)?|gender|sex)(_|$)/,
    logical: /(^|\s)(이름|성명|실명)$|(회원|고객|사용자|수령인|수취인|주문자|보호자|예금주|직원|담당자)\s*(명|이름)$|전화|휴대\s*폰|핸드폰|연락처|이메일|e-?mail|메일\s*주소|주소|우편\s*번호|생년\s*월일|생일|IP\s*주소|접속\s*IP|성별/i,
  },
];

/** 컬럼 이름(물리명·논리명)으로 보아 개인정보로 보이면 그 종류 */
export function guessPrivacy(column: Pick<Column, 'name' | 'logicalName'>): PrivacyKind | null {
  const physical = words(column.name).join('_');
  const logical = column.logicalName.trim();
  for (const p of PATTERNS) {
    if ((p.physical && p.physical.test(physical)) || (p.logical && logical && p.logical.test(logical))) return p.kind;
  }
  return null;
}

export interface PrivacyColumn {
  table: Table;
  column: Column;
  privacy: ColumnPrivacy;
}

/** 개인정보로 표시한 컬럼 (정의서 시트·화면 목록) */
export function privacyColumns(schema: Schema, tableIds?: Set<string>): PrivacyColumn[] {
  const out: PrivacyColumn[] = [];
  for (const table of schema.tables) {
    if (tableIds && !tableIds.has(table.id)) continue;
    for (const column of table.columns) if (column.privacy) out.push({ table, column, privacy: column.privacy });
  }
  return out;
}
