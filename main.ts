// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, in order: [oldPath, newPath] pairs for the `R` report lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
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
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file split into lines (SPEC.md section 3): its own break, its lines, whether it ends with one. */
function fileSplit(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}
function fileJoin(lines: string[], br: string, fin: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (fin ? br : '');
}

/** Tier matching (section 5): tier 0 exact, 1 trailing-ws-insensitive, 2 both-sides-ws-insensitive. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];
function normFor(tier: number, s: string): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const no = O.map((s) => normFor(tier, s));
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) if (normFor(tier, lines[i + k]!) !== no[k]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(lines: string[], O: string[], strict: boolean, from = 0, eof = false): { tier: number; pos: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    let pos = occurrences(lines, O, tier, from);
    if (eof) pos = pos.filter((p) => p + O.length === lines.length);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** One body entry of a hunk or chunk: context, old or new; `bs` marks a following `\` line, `re` a raw empty line. */
interface Ent { k: 'c' | 'o' | 'n'; t: string; bs?: boolean; re?: boolean }
/**
 * The lines a matched hunk or block writes: context entries come from the file itself, new entries
 * as written, re-indented at tier 2 (the first matched line's file indent F replaces O's first
 * line's indent P on every non-blank new line that starts with P).
 */
function buildSegment(fileLines: string[], pos: number, entries: Ent[], tier: number): string[] {
  const F = leadWs(fileLines[pos] ?? '');
  const firstO = entries.find((e) => e.k !== 'n');
  const P = firstO ? leadWs(firstO.t) : '';
  const seg: string[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.k === 'o') { oi++; continue; }
    if (e.k === 'c') { seg.push(fileLines[pos + oi]!); oi++; continue; }
    let t = e.t;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    seg.push(t);
  }
  return seg;
}

/** Unified hunks (section 6): applied in order, each to the result of the ones before it. */
interface Hunk { a: number; entries: Ent[] }
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  const f = fileSplit(text);
  const lines = [...f.lines];
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.entries.filter((e) => e.k !== 'n').map((e) => e.t);
    if (O.length === 0) {
      const seg = h.entries.filter((e) => e.k === 'n').map((e) => e.t);
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      lines.splice(at, 0, ...seg);
      if (at === lines.length - seg.length || (seg.length === 0 && at === lines.length)) {
        const lastN = [...h.entries].reverse().find((e) => e.k !== 'o');
        if (lastN) fin = !lastN.bs;
      }
      d += seg.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const seg = buildSegment(lines, pos, h.entries, found.tier);
    const ranToEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...seg);
    if (ranToEnd) {
      const lastN = [...h.entries].reverse().find((e) => e.k !== 'o');
      if (lastN) fin = !lastN.bs;
    }
    d += seg.length - O.length;
  }
  return fileJoin(lines, f.br, fin);
}

/** The content of a created file in a unified section: the `+` lines of all its hunks, in order. */
function createdText(hunks: Hunk[]): string {
  const plus: Ent[] = [];
  for (const h of hunks) for (const e of h.entries) if (e.k === 'n') plus.push(e);
  if (plus.length === 0) return '';
  return plus.map((e) => e.t).join('\n') + (plus[plus.length - 1]!.bs ? '' : '\n');
}

interface Section {
  gitOld?: string; gitNew?: string; oldP?: string; newP?: string;
  renFrom?: string; renTo?: string; newFile: boolean; delFile: boolean; hunks: Hunk[];
}
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
function headerPath(raw: string): string {
  return raw.split('\t')[0]!.trim();
}

/** Unified diffs (section 6), parsed whole before any edit runs. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const endHunk = (): void => {
    if (hunk) {
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.re) hunk.entries.pop();
      hunk = null;
    }
  };
  const endSection = (): void => { endHunk(); if (sec) { sections.push(sec); sec = null; } };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (hunk) {
      const isDiff = line.startsWith('diff --git ');
      const isPair = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      const c0 = line[0];
      if (!isDiff && !isPair && (line === '' || c0 === ' ' || c0 === '-' || c0 === '+' || c0 === '\\')) {
        if (line === '') hunk.entries.push({ k: 'c', t: '', re: true });
        else if (c0 === ' ') hunk.entries.push({ k: 'c', t: line.slice(1) });
        else if (c0 === '-') hunk.entries.push({ k: 'o', t: line.slice(1) });
        else if (c0 === '+') hunk.entries.push({ k: 'n', t: line.slice(1) });
        else { const prev = hunk.entries[hunk.entries.length - 1]; if (prev) prev.bs = true; }
        i++;
        continue;
      }
      endHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${no}`);
      endSection();
      sec = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const inHeader = sec !== null && sec.hunks.length === 0 && hunk === null;
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!inHeader) { endSection(); sec = { newFile: false, delFile: false, hunks: [] }; }
        sec!.oldP = headerPath(line.slice(4));
        sec!.newP = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${no + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!sec) throw new Exit2(`error: parse ${no}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${no}`);
      hunk = { a: Number(m[1]), entries: [] };
      sec.hunks.push(hunk);
      i++;
      continue;
    }
    if (sec && sec.hunks.length === 0 && hunk === null) {
      if (line.startsWith('rename from ')) sec.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    i++;
  }
  endSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s): Edit => (tree) => {
    const isCreate = s.newFile || s.oldP === '/dev/null';
    const isDelete = s.delFile || s.newP === '/dev/null';
    const oldRaw = s.oldP !== undefined && s.oldP !== '/dev/null' ? stripAB(s.oldP) : s.renFrom ?? s.gitOld;
    const newRaw = s.newP !== undefined && s.newP !== '/dev/null' ? stripAB(s.newP) : s.renTo ?? s.gitNew;
    if (isCreate) {
      const p = newRaw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText(s.hunks));
      return;
    }
    if (isDelete) {
      const p = oldRaw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldRaw !== undefined && newRaw !== undefined && oldRaw !== newRaw) {
      if (!safe(oldRaw)) throw new Fail('unsafe', oldRaw);
      if (!safe(newRaw)) throw new Fail('unsafe', newRaw);
      const before = tree.get(oldRaw);
      if (before === null) throw new Fail('missing', oldRaw);
      if (tree.get(newRaw) !== null) throw new Fail('exists', newRaw);
      tree.now.set(newRaw, applyHunks(before, s.hunks, oldRaw, strict));
      tree.now.set(oldRaw, null);
      tree.moves.push([oldRaw, newRaw]);
      return;
    }
    const p = (oldRaw ?? newRaw)!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, p, strict));
  });
}

/** SEARCH/REPLACE blocks (section 7), parsed whole before any edit runs. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let from = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j >= from; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine}`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchLine}`);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    const path = p;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const f = fileSplit(before);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const pos = found.pos[0]!;
      const entries: Ent[] = [...oldLines.map((t): Ent => ({ k: 'o', t })), ...newLines.map((t): Ent => ({ k: 'n', t }))];
      const seg = buildSegment(f.lines, pos, entries, found.tier);
      const out = [...f.lines];
      out.splice(pos, oldLines.length, ...seg);
      tree.now.set(path, fileJoin(out, f.br, f.final));
    });
    prevPath = p;
    from = k + 1;
    i = k + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (section 8), parsed whole before any edit runs. */
interface Chunk { anchor: string | null; eof: boolean; entries: Ent[] }
interface VSec { kind: 'add' | 'del' | 'upd'; path: string; line: number; moveTo?: string; addLines: { t: string; re?: boolean }[]; chunks: Chunk[] }
function applyChunks(text: string, chunks: Chunk[], path: string, strict: boolean): string {
  const f = fileSplit(text);
  const lines = [...f.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let x = cursor; x < lines.length; x++) if (normFor(tier, lines[x]!) === normFor(tier, ch.anchor)) { at = x; break; }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const O = ch.entries.filter((e) => e.k !== 'n').map((e) => e.t);
    if (O.length === 0) {
      const seg = ch.entries.filter((e) => e.k === 'n').map((e) => e.t);
      const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(at, 0, ...seg);
      cursor = at + seg.length;
      continue;
    }
    const found = findTier(lines, O, strict, cursor, ch.eof);
    if (!found) throw new Fail('no-match', path);
    const pos = found.pos[0]!;
    const seg = buildSegment(lines, pos, ch.entries, found.tier);
    lines.splice(pos, O.length, ...seg);
    cursor = pos + seg.length;
  }
  return fileJoin(lines, f.br, f.final);
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let x = lines.length - 1; x >= 0; x--) if (!blank(lines[x]!)) { lb = x; break; }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let cur: VSec | null = null;
  let chunk: Chunk | null = null;
  let chunkEnded = false;
  // Trailing empty context entries of a closing chunk are section-end blank lines, not chunk lines.
  const stripChunk = (c: Chunk): void => {
    while (c.entries.length > 0) {
      const last = c.entries[c.entries.length - 1]!;
      if (last.k === 'c' && last.t === '') c.entries.pop();
      else break;
    }
  };
  const endSection = (): void => {
    if (!cur) return;
    if (cur.kind === 'add') while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1]!.re) cur.addLines.pop();
    if (cur.kind === 'upd') {
      const last = cur.chunks[cur.chunks.length - 1];
      if (last) stripChunk(last);
      cur.chunks = cur.chunks.filter((c) => c.entries.length > 0 || c.anchor !== null || c.eof);
      if (cur.chunks.length === 0 && cur.moveTo === undefined) throw new Exit2(`error: parse ${cur.line}`);
    }
    secs.push(cur);
    cur = null;
    chunk = null;
    chunkEnded = false;
  };
  for (let i = fb + 1; i < lb; i++) {
    const line = lines[i]!;
    const no = i + 1;
    let kind: VSec['kind'] | null = null;
    let pfx = '';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; pfx = '*** Add File: '; }
    else if (line.startsWith('*** Delete File: ')) { kind = 'del'; pfx = '*** Delete File: '; }
    else if (line.startsWith('*** Update File: ')) { kind = 'upd'; pfx = '*** Update File: '; }
    if (kind) {
      endSection();
      cur = { kind, path: line.slice(pfx.length).trim(), line: no, addLines: [], chunks: [] };
      continue;
    }
    if (!cur) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${no}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push({ t: line.slice(1) });
      else if (line === '') cur.addLines.push({ t: '', re: true });
      else throw new Exit2(`error: parse ${no}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (line === '') continue;
      throw new Exit2(`error: parse ${no}`);
    }
    // update section
    if (line.startsWith('*** Move to: ') && cur.chunks.length === 0 && chunk === null && cur.moveTo === undefined) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      if (chunk) stripChunk(chunk);
      chunk = { anchor: line.slice(2).trim() || null, eof: false, entries: [] };
      cur.chunks.push(chunk);
      chunkEnded = false;
      continue;
    }
    if (line === '*** End of File') {
      if (!chunk) { chunk = { anchor: null, eof: true, entries: [] }; cur.chunks.push(chunk); }
      chunk.eof = true;
      chunkEnded = true;
      continue;
    }
    const c0 = line[0];
    if (line === '' || c0 === ' ' || c0 === '-' || c0 === '+') {
      if (!chunk || chunkEnded) { chunk = { anchor: null, eof: false, entries: [] }; cur.chunks.push(chunk); chunkEnded = false; }
      if (line === '') chunk.entries.push({ k: 'c', t: '', re: true });
      else if (c0 === ' ') chunk.entries.push({ k: 'c', t: line.slice(1) });
      else if (c0 === '-') chunk.entries.push({ k: 'o', t: line.slice(1) });
      else chunk.entries.push({ k: 'n', t: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  endSection();
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s): Edit => (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const ls = s.addLines.map((l) => l.t);
      tree.now.set(s.path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const after = applyChunks(before, s.chunks, s.path, strict);
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, after);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else tree.now.set(s.path, after);
  });
}

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
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
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
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const fin = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  // Compose the recorded moves into original -> final pairs (a chain a->b, b->c reports as a->c),
  // then keep the pairs whose before/after states match SPEC.md section 2's `R` line conditions.
  const composed = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    let src = o;
    for (const [x, y] of composed) if (y === o) { src = x; composed.delete(x); break; }
    composed.set(src, n);
  }
  const rByNew = new Map<string, string>();
  for (const [o, n] of composed) {
    if (o !== n && tree.original(o) !== null && fin(o) === null && tree.original(n) === null && fin(n) !== null) rByNew.set(n, o);
  }
  const rOlds = new Set(rByNew.values());
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOlds.has(p)) continue;
    if (rByNew.has(p)) rows.push({ key: p, text: `R ${rByNew.get(p)!} -> ${p}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
