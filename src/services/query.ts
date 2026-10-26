/**
 * Natural-language query planner for Forreyra.
 *
 * Turns a plain-English request ("what is the price", "list the links about
 * docs", "how many rows are in the table") into a deterministic, typed plan, then
 * resolves that plan against structured page data. There is no model call: the
 * same query always produces the same plan and the same result, which keeps the
 * browser tool explainable and testable.
 */

export type QueryKind =
  | 'title'
  | 'headings'
  | 'links'
  | 'emails'
  | 'phones'
  | 'prices'
  | 'table'
  | 'count'
  | 'labeled'
  | 'search';

export interface QueryPlan {
  kind: QueryKind;
  /** A keyword to filter by, when the request named one. */
  term?: string;
  raw: string;
}

export interface QueryMatch {
  value: string;
  href?: string;
}

export interface QueryResult {
  kind: QueryKind;
  query: string;
  matches: QueryMatch[];
  note?: string;
}

export interface PageData {
  url: string;
  title: string;
  text: string;
  headings: string[];
  links: { text: string; href: string }[];
  /** Each table is a list of rows; each row is a list of cell strings. */
  tables: string[][][];
  fields: { label: string; value: string }[];
}

const NOUNS = [
  'links', 'link', 'urls', 'url', 'headings', 'heading', 'headers', 'header',
  'sections', 'section', 'emails', 'email', 'e-mail', 'phones', 'phone',
  'prices', 'price', 'cost', 'tables', 'table', 'rows', 'row', 'title',
];

/** Pull the subject out of a request: quoted text wins, else the tail after a lead-in. */
export function extractTerm(query: string): string {
  const quoted = /["'“”‘’]([^"'“”‘’]+)["'“”‘’]/.exec(query);
  if (quoted) return quoted[1].trim();

  const lead = /\b(?:about|for|containing|with|named|called|that say|saying|mentioning|regarding)\s+(.+)$/.exec(query);
  if (lead) return cleanTerm(lead[1]);

  return cleanTerm(query);
}

/** Strip question words, nouns, and filler so only the subject keyword remains. */
function cleanTerm(text: string): string {
  let t = text
    .replace(/\b(?:please|can you|could you|i want|i need|show me|tell me|give me|list|show|find|get|extract|fetch|all|the|a|an|of|in|on|from|are|is|what|what's|whats|which|how|many|do|does|and|to|me|value)\b/gi, ' ')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const n of NOUNS) t = t.replace(new RegExp(`\\b${n}\\b`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  return t;
}

const STOPWORDS = new Set([
  'when', 'where', 'who', 'why', 'does', 'did', 'will', 'would', 'the', 'and', 'for',
  'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'its',
  'it', 'of', 'to', 'in', 'on', 'at', 'by', 'or', 'is',
]);

/** Split a phrase into significant search keywords (>=3 chars, no stopwords). */
function keywords(term: string): string[] {
  return term
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function countNoun(lc: string): string {
  if (/\blinks?\b/.test(lc)) return 'links';
  if (/\brows?\b/.test(lc)) return 'rows';
  if (/\bheadings?\b|\bheaders?\b|\bsections?\b/.test(lc)) return 'headings';
  if (/\btables?\b/.test(lc)) return 'tables';
  return '';
}

/** Map a plain-English request to a typed plan. Order of tests is the priority. */
export function planQuery(raw: string): QueryPlan {
  const q = raw.trim();
  const lc = q.toLowerCase();
  const term = extractTerm(lc);

  if (/\bhow many\b/.test(lc)) return { kind: 'count', term: countNoun(lc), raw: q };
  if (/\b(title|headline|page name)\b/.test(lc)) return { kind: 'title', raw: q };
  if (/\b(e-?mails?|mail address)\b/.test(lc)) return { kind: 'emails', raw: q };
  if (/\b(phones?|telephones?|tel(?:ephone)? number|phone number)\b/.test(lc)) return { kind: 'phones', raw: q };
  if (/\b(prices?|costs?|how much)\b/.test(lc)) return { kind: 'prices', raw: q };
  if (/\b(headings?|headers?|sections?)\b/.test(lc)) return { kind: 'headings', term, raw: q };
  if (/\b(tables?|rows?)\b/.test(lc)) return { kind: 'table', term, raw: q };
  if (/\b(links?|urls?|hyperlinks?)\b/.test(lc)) return { kind: 'links', term, raw: q };

  const labeled = /(?:value of|what is|what's|whats)\s+(.+)$/.exec(lc);
  if (labeled) return { kind: 'labeled', term: cleanTerm(labeled[1]), raw: q };

  return { kind: 'search', term: term || lc, raw: q };
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const PRICE = /(?:[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:usd|eur|gbp|dollars?|euros?|pounds?))/gi;

const uniq = (items: string[]): string[] => Array.from(new Set(items));

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Resolve a plan against page data. Pure: same input, same output. */
export function runQuery(data: PageData, plan: QueryPlan): QueryResult {
  const base = { kind: plan.kind, query: plan.raw };
  const has = (hay: string) => (plan.term ? hay.toLowerCase().includes(plan.term.toLowerCase()) : true);

  switch (plan.kind) {
    case 'title':
      return { ...base, matches: data.title ? [{ value: data.title }] : [], note: data.title ? undefined : 'No title on the page.' };

    case 'headings': {
      const matches = data.headings.filter(has).map((value) => ({ value }));
      return { ...base, matches, note: matches.length ? undefined : 'No matching headings.' };
    }

    case 'links': {
      const matches = data.links.filter((l) => has(`${l.text} ${l.href}`)).map((l) => ({ value: l.text || l.href, href: l.href }));
      return { ...base, matches, note: matches.length ? undefined : 'No matching links.' };
    }

    case 'emails': {
      const matches = uniq((data.text.match(EMAIL) ?? [])).map((value) => ({ value }));
      return { ...base, matches, note: matches.length ? undefined : 'No email addresses found.' };
    }

    case 'phones': {
      const matches = uniq((data.text.match(PHONE) ?? []).map((p) => p.trim()).filter((p) => (p.match(/\d/g) ?? []).length >= 8)).map((value) => ({ value }));
      return { ...base, matches, note: matches.length ? undefined : 'No phone numbers found.' };
    }

    case 'prices': {
      const matches = uniq((data.text.match(PRICE) ?? []).map((p) => p.trim())).map((value) => ({ value }));
      return { ...base, matches, note: matches.length ? undefined : 'No prices found.' };
    }

    case 'table': {
      const table = (plan.term ? data.tables.find((t) => t.some((row) => row.some(has))) : data.tables[0]) ?? data.tables[0];
      const rows = table ?? [];
      const matches = rows.map((row) => ({ value: row.join(' | ') }));
      return { ...base, matches, note: matches.length ? undefined : 'No table found.' };
    }

    case 'count': {
      let n = 0;
      if (plan.term === 'links') n = data.links.length;
      else if (plan.term === 'headings') n = data.headings.length;
      else if (plan.term === 'tables') n = data.tables.length;
      else if (plan.term === 'rows') n = data.tables.reduce((a, t) => a + t.length, 0);
      else n = data.links.length;
      return { ...base, matches: [{ value: String(n) }] };
    }

    case 'labeled': {
      const words = plan.term ? plan.term.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const field = data.fields.find((f) => words.every((w) => f.label.toLowerCase().includes(w)));
      return { ...base, matches: field ? [{ value: field.value }] : [], note: field ? undefined : `No field labelled "${plan.term}".` };
    }

    case 'search':
    default: {
      const words = keywords(plan.term ?? plan.raw);
      const match = (s: string) => {
        const lc = s.toLowerCase();
        if (words.length) return words.every((w) => lc.includes(w));
        return plan.term ? lc.includes(plan.term.toLowerCase()) : true;
      };
      const matches = sentences(data.text).filter(match).map((value) => ({ value }));
      return { ...base, matches, note: matches.length ? undefined : `No text matched "${plan.term}".` };
    }
  }
}

/** Render a result as compact text for the brain / MCP client. */
export function renderQueryResult(result: QueryResult): string {
  const header = `query: ${result.query}\nkind: ${result.kind}\nmatches: ${result.matches.length}`;
  if (!result.matches.length) return `${header}\n${result.note ?? 'No matches.'}`;
  const lines = result.matches.map((m) => (m.href ? `- ${m.value} -> ${m.href}` : `- ${m.value}`));
  return `${header}\n${lines.join('\n')}`;
}
