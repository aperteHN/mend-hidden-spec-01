// mend: one patch tool for every AI edit format. Implements SPEC.md sections 1-10.
// Node 22 standard library only. Run as node main.ts [options] [PATCH]
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 { readonly line: string; constructor(line: string) { this.line = line; } }
class Fail { readonly code: string; readonly path: string; constructor(code: string, path: string) { this.code = code; this.path = path; } }

const blank = (s: string): boolean => s.trim() === '';
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}
function checkSafe(p: string): void { if (!safe(p)) throw new Fail('unsafe', p); }

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null { return this.now.has(p) ? this.now.get(p)! : this.original(p); }
}
type Edit = (tree: Tree) => void;

// ---- file line model (section 3) ----
interface Parts { br: string; lines: string[]; final: boolean }
function fileParts(text: string): Parts {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br: '\n', lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinParts(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ---- tier matching (section 5) ----
const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}
function occurrences(lines: string[], O: string[], tier: number, start: number, eofOnly = false): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, start); i + O.length <= lines.length; i++) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < O.length; k++) if (!eqTier(lines[i + k]!, O[k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function firstTier(lines: string[], O: string[], strict: boolean, start = 0, eofOnly = false): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, O, t, start, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
const leadST = (s: string): string => (/^[ \t]*/.exec(s)?.[0] ?? '');
function reindent(line: string, tier: number, F: string, P: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}
// Build replacement lines for a matched region: body entries in order, context taken from file.
type BodyEntry = { type: string; text: string };
function buildReplacement(body: BodyEntry[], fileLines: string[], pos: number, tier: number): string[] {
  const Otexts = body.filter((e) => e.type === ' ' || e.type === '-').map((e) => e.text);
  const F = fileLines[pos] !== undefined ? leadST(fileLines[pos]!) : '';
  const P = Otexts.length > 0 ? leadST(Otexts[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.type === ' ') { out.push(fileLines[pos + oi]!); oi++; }
    else if (e.type === '-') { oi++; }
    else if (e.type === '+') { out.push(reindent(e.text, tier, F, P)); }
  }
  return out;
}
function plainReplacement(newLines: string[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const F = fileLines[pos] !== undefined ? leadST(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadST(O[0]!) : '';
  return newLines.map((l) => reindent(l, tier, F, P));
}

// ---- format detection (section 4) ----
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (section 9) ----
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    checkSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => { checkSafe(p); if (tree.get(p) !== null) throw new Fail('exists', p); tree.now.set(p, text); };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str; const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before); const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line; const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = fileParts(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      const lines = [...parts.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinParts(lines, parts.br, parts.final));
    };
  }
  return null;
}
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) { const e = jsonEdit(x); if (e === null) throw new Exit2(`error: parse ${first + 1}`); edits.push(e); }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (section 6) ----
interface Hunk { a: number; body: BodyEntry[] }
interface Section { oldPath: string | null; newPath: string | null; hasPair: boolean; newFile: boolean; delFile: boolean; hunks: Hunk[] }
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}
function headerPath(raw: string): string {
  let t = raw.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return stripPrefix(t.trim());
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const startSection = (): Section => { const s: Section = { oldPath: null, newPath: null, hasPair: false, newFile: false, delFile: false, hunks: [] }; sections.push(s); return s; };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.oldPath = m[1]!; cur.newPath = m[2]!;
      i++; continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // starts a new section when current already has a pair or hunks, otherwise fills current header
      if (cur === null || cur.hasPair || cur.hunks.length > 0) cur = startSection();
      cur.oldPath = headerPath(line); cur.newPath = headerPath(lines[i + 1]!); cur.hasPair = true;
      i += 2; continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: BodyEntry[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = bl[0];
        if (bl === '') { body.push({ type: ' ', text: '' }); i++; }
        else if (c === ' ' || c === '-' || c === '+' || c === '\\') { body.push({ type: c, text: c === '\\' ? bl : bl.slice(1) }); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1]!.type === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    // header lines before first hunk
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        // a --- line inside a header not followed by +++ is a parse error at the line after it
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) { if (!cur.hasPair) cur.oldPath = stripPrefix(line.slice(12).trim()); i++; continue; }
      if (line.startsWith('rename to ')) { if (!cur.hasPair) cur.newPath = stripPrefix(line.slice(10).trim()); i++; continue; }
      if (line.startsWith('new file mode')) { cur.newFile = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.delFile = true; i++; continue; }
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    edits.push((tree) => applyUnifiedSection(tree, s, strict));
  }
  return edits;
}
function hasBackslashAfterLastPlusOrContext(body: BodyEntry[]): boolean {
  let lastIdx = -1;
  body.forEach((e, idx) => { if (e.type === ' ' || e.type === '+') lastIdx = idx; });
  if (lastIdx < 0) return false;
  for (let k = lastIdx + 1; k < body.length; k++) if (body[k]!.type === '\\') return true;
  return false;
}
function applyUnifiedSection(tree: Tree, s: Section, strict: boolean): void {
  const isCreate = s.oldPath === '/dev/null' || s.newFile;
  const isDelete = s.newPath === '/dev/null' || s.delFile;
  // resolve paths
  let oldP = s.oldPath; let newP = s.newPath;
  if (isCreate) {
    const np = newP ?? oldP;
    if (np === null || np === '/dev/null') throw new Fail('missing', np ?? '');
    checkSafe(np);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const outLines: string[] = [];
    for (const h of s.hunks) for (const e of h.body) if (e.type === '+') outLines.push(e.text);
    let final = true;
    if (s.hunks.length > 0) { const last = s.hunks[s.hunks.length - 1]!; if (hasBackslashAfterLastPlusOrContext(last.body)) final = false; }
    tree.now.set(np, outLines.length === 0 ? '' : outLines.join('\n') + (final ? '\n' : ''));
    return;
  }
  if (isDelete) {
    const op = oldP ?? newP;
    if (op === null || op === '/dev/null') throw new Fail('missing', op ?? '');
    checkSafe(op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, null);
    return;
  }
  const op = oldP; const np = newP ?? oldP;
  if (op === null) throw new Fail('missing', '');
  checkSafe(op);
  if (np !== null && np !== op) checkSafe(np);
  const before = tree.get(op);
  if (before === null) throw new Fail('missing', op);
  const isMove = np !== null && np !== op;
  if (isMove && tree.get(np!) !== null) throw new Fail('exists', np!);
  const targetPath = np ?? op;
  const parts = fileParts(before);
  let fileLines = [...parts.lines];
  let final = parts.final;
  let d = 0;
  for (const h of s.hunks) {
    const O = h.body.filter((e) => e.type === ' ' || e.type === '-').map((e) => e.text);
    const Nlen = h.body.filter((e) => e.type === ' ' || e.type === '+').length;
    if (O.length === 0) {
      const repl = h.body.filter((e) => e.type === '+').map((e) => e.text);
      const pos = Math.min(h.a + d, fileLines.length);
      const atEnd = pos >= fileLines.length;
      fileLines.splice(pos, 0, ...repl);
      if (atEnd) final = !hasBackslashAfterLastPlusOrContext(h.body);
      d += repl.length;
    } else {
      const found = firstTier(fileLines, O, strict);
      if (!found) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.occ[0]!; let bestDist = Math.abs(best - target);
      for (const cand of found.occ) { const dist = Math.abs(cand - target); if (dist < bestDist) { best = cand; bestDist = dist; } }
      const repl = buildReplacement(h.body, fileLines, best, found.tier);
      const runsToEnd = best + O.length === fileLines.length;
      fileLines.splice(best, O.length, ...repl);
      if (runsToEnd) final = !hasBackslashAfterLastPlusOrContext(h.body);
      d += Nlen - O.length;
    }
  }
  const result = joinParts(fileLines, parts.br, final);
  if (isMove) { tree.now.set(op, null); tree.now.set(targetPath, result); tree.moves.push([op, targetPath]); }
  else tree.now.set(op, result);
}

// ---- SEARCH/REPLACE (section 7) ----
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block { path: string; oldLines: string[]; newLines: string[] }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    // find path: nearest non-blank, non-fence line before, after searchFrom
    let path: string | null = null;
    for (let k = searchLine - 1; k >= searchFrom; k--) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim(); break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    // find ======= then >>>>>>> REPLACE
    let eq = -1; let rep = -1;
    for (let k = searchLine + 1; k < lines.length; k++) { if (lines[k]!.trimEnd() === '=======') { eq = k; break; } }
    if (eq >= 0) for (let k = eq + 1; k < lines.length; k++) { if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; } }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    checkSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = fileParts(before);
    const found = firstTier(parts.lines, b.oldLines, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const repl = plainReplacement(b.newLines, parts.lines, pos, found.tier, b.oldLines);
    const out = [...parts.lines];
    out.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(b.path, joinParts(out, parts.br, parts.final));
  });
}

// ---- V4A (section 8) ----
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk { anchor: string | null; eof: boolean; body: BodyEntry[] }
  interface VSection { kind: string; path: string; lineNo: number; moveTo: string | null; addLines: string[]; chunks: Chunk[] }
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: Chunk | null = null;
  const flushTrailingBlanks = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') { while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop(); }
    if (cur.kind === 'update' && curChunk) { while (curChunk.body.length > 0 && curChunk.body[curChunk.body.length - 1]!.type === ' ' && curChunk.body[curChunk.body.length - 1]!.text === '') curChunk.body.pop(); }
  };
  for (let idx = first + 1; idx < last; idx++) {
    const line = lines[idx]!;
    const isAdd = line.startsWith('*** Add File: ');
    const isDel = line.startsWith('*** Delete File: ');
    const isUpd = line.startsWith('*** Update File: ');
    if (isAdd || isDel || isUpd) {
      flushTrailingBlanks();
      cur = { kind: isAdd ? 'add' : isDel ? 'delete' : 'update', path: (isAdd ? line.slice(14) : isDel ? line.slice(17) : line.slice(17)).trim(), lineNo: idx + 1, moveTo: null, addLines: [], chunks: [] };
      sections.push(cur); curChunk = null; continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else if (line === '') cur.addLines.push('');
      else throw new Exit2(`error: parse ${idx + 1}`);
      continue;
    }
    if (cur.kind === 'delete') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    // update
    if (line.startsWith('*** Move to: ') && cur.chunks.length === 0 && curChunk === null) { cur.moveTo = line.slice(13).trim(); continue; }
    if (line.startsWith('*** End of File')) {
      if (curChunk === null) { curChunk = { anchor: null, eof: true, body: [] }; cur.chunks.push(curChunk); }
      else curChunk.eof = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      cur.chunks.push(curChunk); continue;
    }
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (curChunk === null) { curChunk = { anchor: null, eof: false, body: [] }; cur.chunks.push(curChunk); }
      if (line === '') curChunk.body.push({ type: ' ', text: '' });
      else curChunk.body.push({ type: c!, text: line.slice(1) });
      continue;
    }
    if (blank(line)) continue;
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  flushTrailingBlanks();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
  }
  return sections.map((s) => (tree: Tree) => applyV4aSection(tree, s, strict));
}
function applyV4aSection(tree: Tree, s: { kind: string; path: string; moveTo: string | null; addLines: string[]; chunks: Array<{ anchor: string | null; eof: boolean; body: BodyEntry[] }> }, strict: boolean): void {
  checkSafe(s.path);
  if (s.kind === 'add') {
    if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
    tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'delete') {
    if (tree.get(s.path) === null) throw new Fail('missing', s.path);
    tree.now.set(s.path, null);
    return;
  }
  const before = tree.get(s.path);
  if (before === null) throw new Fail('missing', s.path);
  if (s.moveTo !== null) { checkSafe(s.moveTo); if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo); }
  const parts = fileParts(before);
  let fileLines = [...parts.lines];
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      // find anchor line at or after cursor, first tier with a hit
      let foundPos = -1;
      const maxTier = strict ? 0 : 2;
      for (let t = 0; t <= maxTier && foundPos < 0; t++) {
        for (let k = cursor; k < fileLines.length; k++) if (eqTier(fileLines[k]!, chunk.anchor, t)) { foundPos = k; break; }
      }
      if (foundPos < 0) throw new Fail('no-match', s.path);
      cursor = foundPos + 1;
    }
    const O = chunk.body.filter((e) => e.type === ' ' || e.type === '-').map((e) => e.text);
    if (O.length === 0) {
      const repl = chunk.body.filter((e) => e.type === '+').map((e) => e.text);
      const pos = chunk.eof ? fileLines.length : Math.min(cursor, fileLines.length);
      fileLines.splice(pos, 0, ...repl);
      cursor = pos + repl.length;
    } else {
      const found = firstTier(fileLines, O, strict, cursor, chunk.eof);
      if (!found) throw new Fail('no-match', s.path);
      const pos = found.occ[0]!;
      const repl = buildReplacement(chunk.body, fileLines, pos, found.tier);
      fileLines.splice(pos, O.length, ...repl);
      cursor = pos + repl.length;
    }
  }
  const result = joinParts(fileLines, parts.br, parts.final);
  if (s.moveTo !== null) { tree.now.set(s.path, null); tree.now.set(s.moveTo, result); tree.moves.push([s.path, s.moveTo]); }
  else tree.now.set(s.path, result);
}

// ---- main run (sections 1, 2, 10) ----
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try { text = readFileSync(file ?? 0, 'utf8'); } catch { if (file !== null) return { code: 2, out: ['error: no-patch'] }; }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try { edit(tree); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // output rows, with R lines for qualifying moves
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const movePairs = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined);
  const inMove = new Set<string>();
  for (const [o, n] of movePairs) { inMove.add(o); inMove.add(n); }
  type Row = { key: string; line: string };
  const rows: Row[] = [];
  for (const [o, n] of movePairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of changed) {
    if (inMove.has(p)) continue;
    const was = tree.original(p); const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
