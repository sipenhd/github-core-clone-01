// A standalone GitHub-compatible git forge: git smart HTTP (protocol v2/v0),
// REST v3, GraphQL v4 and MCP, from one Node process, standard library only.
// No UI, no outside service, no git binary. The store is in memory; every
// timestamp the forge emits is a fixed constant, so two runs on the same
// instance leave the same observable state.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const STRANGER_LOGIN = 'olgabauer';
const FIXED_TIME = '2026-01-01T00:00:00Z';
const FIXED_EPOCH = 1700000000;
const ZERO_OID = '0'.repeat(40);
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
let globalIdCounter = 1;

// ---------------------------------------------------------------- git objects
type GitType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject { type: GitType; data: Buffer }
const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function isOid(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }

interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: GitType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp >= 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return { object: m.get('object') ?? '', type: (m.get('type') ?? 'commit') as GitType, tag: m.get('tag') ?? '', tagger: m.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}
function buildCommit(tree: string, parents: string[], message: string, author: string): Buffer {
  const who = `${author} ${FIXED_EPOCH} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
// Reachable objects from roots, following commit->tree/parents, tag->target, tree->entries.
function collectReachable(roots: string[], lookup: (oid: string) => GitObject | undefined, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid) || !isOid(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!(stopAt && stopAt.has(oid))) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}
function isAncestor(objects: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}
// Flatten a tree to path -> {oid, mode}.
function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [k, v] of flattenTree(objects, e.oid, path)) out.set(k, v);
    } else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}
function treeFromFiles(objects: Map<string, GitObject>, files: Map<string, Buffer>): string {
  interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], make());
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of node.files) {
      const oid = hashObject('blob', data);
      objects.set(oid, { type: 'blob', data });
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

// ---------------------------------------------------------------- packfiles
function writePackObjectHeader(type: GitType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) { bytes.push(first | 0x80); first = remaining & 0x7f; remaining = Math.floor(remaining / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buf[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]; let off = start + 1; let value = byte & 0x7f;
  while (byte & 0x80) { byte = buf[off++]; value = ((value + 1) * 128) + (byte & 0x7f); }
  return { baseOffset: value, next: off };
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let shift = 0;
    for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** shift; shift += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0; let copySize = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift; shift += 8; }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
// Parse a packfile into objects (plain + OFS/REF deltas resolved).
function readPack(pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObject; oid?: string }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) { const b = readOfsBase(pack, offset); offset = b.next; entry.baseOffset = entryOffset - b.baseOffset; }
    else if (typeCode === 7) { entry.baseOid = pack.subarray(offset, offset + 20).toString('hex'); offset += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved && entry.oid) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let obj: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs base missing');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (!baseEntry) throw new Error('ref base missing');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    entry.oid = hashObject(obj.type, obj.data);
    entry.resolved = obj;
    byOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  return raw.map((e) => resolve(e));
}

// ---------------------------------------------------------------- pkt-lines
function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = parseInt(head, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}
function pktTextLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const { packets, rest } = decodePktLines(buf);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
    else if (p.kind === 'flush') lines.push('\0FLUSH');
    else if (p.kind === 'delim') lines.push('\0DELIM');
  }
  return { lines, rest };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 60000) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 60000));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- store
interface Label { id: number; name: string; color: string; description: string }
interface IssueComment { id: number; nodeId: string; body: string; seq: number }
interface Issue { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; labels: Label[]; comments: IssueComment[]; seq: number }
interface Pull { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; headSha: string; baseSha: string; merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; seq: number }
interface Repo {
  id: number; nodeId: string; name: string; owner: string; description: string | null; isPrivate: boolean;
  defaultBranch: string; refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Issue[]; pulls: Pull[]; labels: Map<string, Label>; nextIssue: number; nextPull: number; seq: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextLabelId = 1;
let nextGlobalId = 100000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function newRepo(name: string, description: string | null, isPrivate: boolean, defaultBranch: string): Repo {
  const id = nextRepoId++;
  const repo: Repo = {
    id, nodeId: `R_${id}`, name, owner: VIEWER_LOGIN, description, isPrivate,
    defaultBranch: defaultBranch || 'main', refs: new Map(), objects: new Map(),
    issues: [], pulls: [], labels: new Map(), nextIssue: 1, nextPull: 1, seq: 0,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}
function ownerUser(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: 'U_1000', avatar_url: 'https://example.invalid/avatar.png', gravatar_id: '', url: `/api/v3/users/${VIEWER_LOGIN}`, html_url: `https://example.invalid/${VIEWER_LOGIN}`, type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL, created_at: FIXED_TIME, updated_at: FIXED_TIME };
}
function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id, node_id: repo.nodeId, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner: ownerUser(), private: repo.isPrivate, html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description, fork: false, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`, git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`, homepage: null, size: 0,
    stargazers_count: 0, watchers_count: 0, language: null, has_issues: true, has_projects: true,
    has_downloads: true, has_wiki: true, has_pages: false, has_discussions: false, forks_count: 0,
    archived: false, disabled: false, open_issues_count: openIssues, license: null, allow_forking: true,
    is_template: false, topics: [], visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch, created_at: FIXED_TIME, updated_at: FIXED_TIME, pushed_at: FIXED_TIME,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: `L_${l.id}`, url: `/api/v3/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: l.description };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: issue.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number, title: issue.title, body: issue.body, user: ownerUser(),
    labels: issue.labels.map(labelJson), state: issue.state, locked: false, assignee: null, assignees: [],
    milestone: null, comments: issue.comments.length, created_at: FIXED_TIME, updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null, author_association: 'OWNER',
    active_lock_reason: null, reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: '', performed_via_github_app: null, state_reason: null,
  };
}
function commentJson(repo: Repo, issue: Issue, c: IssueComment): Record<string, unknown> {
  return { id: c.id, node_id: c.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${c.id}`, html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`, body: c.body, user: ownerUser(), created_at: FIXED_TIME, updated_at: FIXED_TIME, author_association: 'OWNER' };
}
// Diff between two trees (flattened path maps).
function diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const base = flattenTree(repo.objects, baseTreeOid);
  const head = flattenTree(repo.objects, headTreeOid);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const lines = data.toString('utf8').split('\n').filter((l) => l.length > 0).length;
      out.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
    } else if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const lines = data.toString('utf8').split('\n').filter((l) => l.length > 0).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
    } else if (b && h) {
      const oldLines = (repo.objects.get(b.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const newLines = (repo.objects.get(h.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const oldSet = new Set(oldLines); const newSet = new Set(newLines);
      const add = newLines.filter((l) => !oldSet.has(l)).length;
      const del = oldLines.filter((l) => !newSet.has(l)).length;
      out.push({ filename: path, status: 'modified', additions: Math.max(add, 1), deletions: del, changes: Math.max(add, 1) + del });
    }
  }
  return out;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const qa = [a];
  while (qa.length) {
    const oid = qa.pop()!;
    if (ancA.has(oid)) continue;
    ancA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) qa.push(p);
  }
  const qb = [b];
  const seen = new Set<string>();
  while (qb.length) {
    const oid = qb.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) qb.push(p);
  }
  return null;
}
function prMergeable(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return false;
  if (baseTip === pr.baseSha && headTip === pr.headSha) {
    // No movement since creation: mergeable unless head tree equals base tree with no changes? Still mergeable.
    return true;
  }
  const mb = mergeBase(repo, baseTip, headTip);
  if (!mb) return false;
  const mbTree = parseCommit(repo.objects.get(mb)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mbFiles = flattenTree(repo.objects, mbTree);
  const baseFiles = flattenTree(repo.objects, baseTree);
  const headFiles = flattenTree(repo.objects, headTree);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path)?.oid; const b = baseFiles.get(path)?.oid; const h = headFiles.get(path)?.oid;
    const baseChanged = b !== m; const headChanged = h !== m;
    if (baseChanged && headChanged && b !== h) return false;
  }
  return true;
}
function prFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const mb = mergeBase(repo, baseTip, headTip);
  const baseTreeOid = mb ? parseCommit(repo.objects.get(mb)!.data).tree : parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTreeOid = parseCommit(repo.objects.get(headTip)!.data).tree;
  return diffFiles(repo, baseTreeOid, headTreeOid);
}
function prJson(repo: Repo, pr: Pull): Record<string, unknown> {
  const files = pr.state === 'open' || pr.merged ? prFiles(repo, pr) : [];
  const additions = files.reduce((s, f) => s + f.additions, 0);
  const deletions = files.reduce((s, f) => s + f.deletions, 0);
  return {
    id: pr.id, node_id: pr.nodeId, url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number, state: pr.state, title: pr.title, body: pr.body, user: ownerUser(),
    labels: [], milestone: null, locked: false, active_lock_reason: null,
    head: { label: `${repo.owner}:${pr.head}`, ref: pr.head, sha: pr.headSha, user: ownerUser(), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pr.base}`, ref: pr.base, sha: pr.baseSha, user: ownerUser(), repo: repoJson(repo) },
    merged: pr.merged, mergeable: pr.state === 'open' ? prMergeable(repo, pr) : null,
    mergeable_state: pr.state === 'open' ? (prMergeable(repo, pr) ? 'clean' : 'dirty') : 'unknown',
    merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha, draft: false,
    commits: 1, additions, deletions, changed_files: files.length,
    created_at: FIXED_TIME, updated_at: FIXED_TIME, closed_at: pr.state === 'closed' ? FIXED_TIME : null,
    author_association: 'OWNER', auto_merge: null,
  };
}
// Create a commit on a ref from a full file map (contents API / merge).
function commitFiles(repo: Repo, branch: string, files: Map<string, Buffer>, message: string, parentTip: string | null): string {
  const treeOid = treeFromFiles(repo.objects, files);
  const parents = parentTip ? [parentTip] : [];
  const data = buildCommit(treeOid, parents, message, `${VIEWER_NAME} <${VIEWER_EMAIL}>`);
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}
function filesAtTip(repo: Repo, tip: string | null): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!tip) return out;
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return out;
  const tree = parseCommit(obj.data).tree;
  for (const [path, entry] of flattenTree(repo.objects, tree)) {
    const blob = repo.objects.get(entry.oid);
    if (blob) out.set(path, blob.data);
  }
  return out;
}
function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------- git HTTP
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const t = repo.objects.get(target);
    if (t && t.type === 'tag') return peeledOid(repo, target);
    return target;
  }
  if (obj.type === 'commit') return oid;
  return null;
}
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function v0Advertisement(repo: Repo, service: string): Buffer {
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1 symref=HEAD:refs/heads/' + repo.defaultBranch
    : 'symref=HEAD:refs/heads/' + repo.defaultBranch + ' side-band-64k ofs-delta shallow agent=forge/1.0 object-format=sha1 multi_ack multi_ack_detailed';
  const items: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = true;
    const headLine = `${defaultTip ?? ZERO_OID} HEAD`;
    items.push(first ? `${headLine}\0${caps}\n` : `${headLine}\n`);
    first = false;
    for (const r of refs) {
      items.push(`${r.oid} ${r.name}\n`);
      const peeled = peeledOid(repo, r.oid);
      if (r.name.startsWith('refs/tags/') && peeled && peeled !== r.oid) items.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done filter\n', 'object-format=sha1\n', 'flush']);
}
// Compute what a fetch sends. Returns pack objects, shallow boundaries, unshallow list.
function computeFetch(repo: Repo, wants: string[], haves: string[], shallowExisting: string[], depth: number | null): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string) => repo.objects.get(oid);
  const shallowSet = new Set(shallowExisting);
  // Objects the client already holds: reachable from haves, not crossing a shallow boundary.
  const held = new Set<string>();
  for (const h of haves) for (const oid of collectReachable([h], lookup, shallowSet)) held.add(oid);
  // Wanted closure with depth limit (generation distance from a want).
  const dist = new Map<string, number>();
  const queue: { oid: string; d: number }[] = wants.map((w) => ({ oid: w, d: 0 }));
  const wantedCommits = new Set<string>();
  while (queue.length) {
    const { oid, d } = queue.shift()!;
    if (!isOid(oid)) continue;
    if (dist.has(oid) && dist.get(oid)! <= d) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type !== 'commit') { wantedCommits.add(oid); continue; }
    dist.set(oid, d);
    wantedCommits.add(oid);
    if (depth === null || d + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
    }
  }
  const wanted = new Set<string>();
  for (const oid of wantedCommits) {
    const obj = repo.objects.get(oid)!;
    if (obj.type === 'commit') {
      // Reachable from this commit, but stop at its parents beyond the depth cut:
      // collect tree/blobs of the commit itself plus parents only if they are wanted.
      wanted.add(oid);
      for (const x of collectReachable([parseCommit(obj.data).tree], lookup)) wanted.add(x);
    } else {
      for (const x of collectReachable([oid], lookup)) wanted.add(x);
    }
  }
  // Parents of wanted commits that are themselves wanted are already included; make sure
  // their trees/blobs are included too (collectReachable from the commit includes parents,
  // so re-collect per wanted commit limited to wanted set).
  const send = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) send.add(oid);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (d === depth - 1) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) shallow.push(oid);
      }
    }
    for (const old of shallowExisting) {
      const d = dist.get(old);
      if (d !== undefined && d < depth - 1) unshallow.push(old);
    }
  }
  const objects: GitObject[] = [...send].sort().map((oid) => repo.objects.get(oid)!).filter(Boolean);
  return { objects, shallow, unshallow };
}
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, service: string): void {
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
  const ct = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  res.writeHead(200, { 'content-type': ct, 'content-length': body.length });
  res.end(body);
}
function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false; let symrefs = false; let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') unborn = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length).trim());
  }
  const out: (string | 'flush')[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD') && prefixes.length === 0) {
    if (defaultTip) out.push(`${defaultTip} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    else if (unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (symrefs && r.name === 'HEAD') line += ' symref-target:refs/heads/' + repo.defaultBranch;
    if (peel && r.name.startsWith('refs/tags/')) {
      const peeled = peeledOid(repo, r.oid);
      if (peeled && peeled !== r.oid) line += ` peeled:${peeled}`;
    }
    out.push(line + '\n');
  }
  out.push('flush');
  return pktLines(out);
}
function handleFetch(repo: Repo, lines: string[], v2: boolean): Buffer {
  const wants: string[] = []; const haves: string[] = []; const shallowExisting: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallowExisting.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) { const n = parseInt(t.slice(7), 10); if (Number.isFinite(n)) depth = n; }
  }
  const { objects, shallow, unshallow } = computeFetch(repo, wants, haves, shallowExisting, depth);
  const pack = objects.length ? writePack(objects) : null;
  if (v2) {
    const parts: Buffer[] = [];
    const ackLines: string[] = [];
    for (const h of haves) if (repo.objects.has(h)) ackLines.push(`ACK ${h}\n`);
    parts.push(pktLines(['acknowledgments\n', ...(ackLines.length ? ackLines : ['NAK\n']), 'delim']));
    if (shallow.length || unshallow.length) {
      const sLines: string[] = ['shallow-info\n'];
      for (const s of shallow) sLines.push(`shallow ${s}\n`);
      for (const u of unshallow) sLines.push(`unshallow ${u}\n`);
      parts.push(pktLines([...sLines, 'delim']));
    }
    if (pack) {
      parts.push(pktLines(['packfile\n']));
      parts.push(sidebandPack(pack));
    } else {
      parts.push(PKT_FLUSH);
    }
    return Buffer.concat(parts);
  }
  // v0: NAK/ACK + shallow lines as plain pkt-lines, then sideband pack.
  const parts: Buffer[] = [];
  const headLines: string[] = [];
  for (const h of haves) if (repo.objects.has(h)) headLines.push(`ACK ${h}\n`);
  if (!headLines.length) headLines.push('NAK\n');
  for (const s of shallow) headLines.push(`shallow ${s}\n`);
  for (const u of unshallow) headLines.push(`unshallow ${u}\n`);
  parts.push(pktLines(headLines));
  if (pack) parts.push(sidebandPack(pack));
  else parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, body: Buffer): Promise<void> {
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const { lines } = pktTextLines(body);
  const first = (lines[0] ?? '').trim();
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' || first.startsWith('command=');
  let out: Buffer;
  try {
    if (isV2 && first.startsWith('command=ls-refs')) {
      out = handleLsRefs(repo, lines);
    } else if (isV2 && first.startsWith('command=fetch')) {
      out = handleFetch(repo, lines, true);
    } else if (!isV2) {
      out = handleFetch(repo, lines, false);
    } else {
      out = pktLines(['flush']);
    }
  } catch {
    out = pktLines(['flush']);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}
async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, body: Buffer): Promise<void> {
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const { packets, rest } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let unpackOk = true; let unpackDetail = 'ok';
  let packObjects: GitObject[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') break;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const clean = nul >= 0 ? text.slice(0, nul) : text;
    const parts = clean.trim().split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  if (rest.length > 0) {
    try {
      packObjects = readPack(rest);
      for (const o of packObjects) repo.objects.set(hashObject(o.type, o.data), o);
    } catch {
      unpackOk = false; unpackDetail = 'unpacker error';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false; let reason = '';
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) { ok = false; reason = 'ref does not exist'; }
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { ok = false; reason = 'non-fast-forward'; }
        else { repo.refs.delete(cmd.ref); ok = true; }
      } else if (!repo.objects.has(cmd.newOid)) {
        ok = false; reason = 'unpacker error';
      } else if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) { ok = false; reason = 'already exists'; }
        else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
      } else {
        if (current !== cmd.oldOid) { ok = false; reason = 'non-fast-forward'; }
        else if (cmd.ref.startsWith('refs/tags/')) { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
        else if (isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
        else { ok = false; reason = 'non-fast-forward'; }
      }
      reportLines.push(ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${reason}`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error`);
  }
  const inner = pktLines([`unpack ${unpackDetail}\n`, ...reportLines.map((l) => `${l}\n`), 'flush']);
  const outerParts: Buffer[] = [];
  for (let off = 0; off < inner.length; off += 60000) {
    const chunk = inner.subarray(off, Math.min(inner.length, off + 60000));
    outerParts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outerParts.push(PKT_FLUSH);
  const out = Buffer.concat(outerParts);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}

// ---------------------------------------------------------------- HTTP helpers
function reqId(): string { requestCounter += 1; return `req-${requestCounter}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId(), ...headers });
  res.end(text);
}
function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': reqId() });
  res.end();
}
function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ') || h.slice(7).trim() === '') return false;
  if (TOKEN !== '' && h.slice(7).trim() !== TOKEN) return false;
  return true;
}
function parseJsonBody(raw: Buffer): { ok: boolean; value: Record<string, unknown> } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const v = JSON.parse(raw.toString('utf8')) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
    if (Array.isArray(v)) return { ok: true, value: { __array: v } as unknown as Record<string, unknown> };
    return { ok: false, value: {} };
  } catch { return { ok: false, value: {} }; }
}
function paginate<T>(items: T[], q: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (totalPages > 1) {
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}${path}`;
    const mk = (p: number): string => `${base}?${new URLSearchParams({ ...Object.fromEntries(q.entries()), per_page: String(perPage), page: String(p) }).toString()}`;
    const parts: string[] = [];
    if (page < totalPages) parts.push(`<${mk(page + 1)}>; rel="next"`);
    if (page > 1) parts.push(`<${mk(page - 1)}>; rel="prev"`);
    parts.push(`<${mk(1)}>; rel="first"`);
    parts.push(`<${mk(totalPages)}>; rel="last"`);
    link = parts.join(', ');
  }
  return { page: slice, link };
}
function linkHeader(res: ServerResponse, link: string | null, extra: Record<string, string> = {}): Record<string, string> {
  return link ? { link, ...extra } : extra;
}
// Resolve a tree at a ref (branch name, commit oid, or null for default branch tip).
function treeAt(repo: Repo, ref: string | undefined): { treeOid: string; tip: string | null } | null {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (!tip) return null;
    const obj = repo.objects.get(tip);
    if (!obj || obj.type !== 'commit') return null;
    return { treeOid: parseCommit(obj.data).tree, tip };
  }
  const oid = resolveRef(repo, ref);
  if (!oid) return null;
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return { treeOid: parseCommit(obj.data).tree, tip: oid };
  if (obj.type === 'tag') {
    const target = parseTag(obj.data).object;
    const t = repo.objects.get(target);
    if (t && t.type === 'commit') return { treeOid: parseCommit(t.data).tree, tip: target };
  }
  return null;
}
function contentEntry(repo: Repo, path: string, treeOid: string, ref: string | undefined): Record<string, unknown> | null {
  const flat = flattenTree(repo.objects, treeOid);
  const entry = flat.get(path);
  if (entry) {
    const blob = repo.objects.get(entry.oid);
    const data = blob ? blob.data : Buffer.alloc(0);
    return { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, content: data.toString('base64'), sha: entry.oid, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git_url: '', html_url: '', download_url: '' };
  }
  // directory?
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; oid: string; name: string }>();
  for (const [p, e] of flat) {
    if (prefix === '' || p.startsWith(prefix)) {
      const rest = prefix === '' ? p : p.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (rest.includes('/')) children.set(seg, { type: 'dir', oid: '', name: seg });
      else children.set(seg, { type: 'file', oid: e.oid, name: seg });
    }
  }
  if (children.size === 0) return null;
  if (path === '') return { __dir: true, entries: [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((c) => ({ type: c.type, name: c.name, path: c.name, sha: c.oid || hashObject('tree', Buffer.alloc(0)), size: 0, url: '' })) } as unknown as Record<string, unknown>;
  return { __dir: true, entries: [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((c) => ({ type: c.type, name: c.name, path: `${path}/${c.name}`, sha: c.oid || hashObject('tree', Buffer.alloc(0)), size: 0, url: '' })) } as unknown as Record<string, unknown>;
}
function doMerge(repo: Repo, pr: Pull): { ok: boolean; sha?: string; message?: string } {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return { ok: false, message: 'Not Found' };
  if (!prMergeable(repo, pr)) return { ok: false, message: 'Merge conflict' };
  const mb = mergeBase(repo, baseTip, headTip);
  const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : parseCommit(repo.objects.get(baseTip)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const mbFiles = flattenTree(repo.objects, mbTree);
  const baseFiles = flattenTree(repo.objects, baseTree);
  const headFiles = flattenTree(repo.objects, headTree);
  // Result tree: base files, with head's changes relative to merge-base applied.
  const result = new Map<string, Buffer>();
  for (const [path, entry] of baseFiles) {
    const blob = repo.objects.get(entry.oid);
    if (blob) result.set(path, blob.data);
  }
  for (const [path, entry] of headFiles) {
    if (mbFiles.get(path)?.oid !== entry.oid) {
      const blob = repo.objects.get(entry.oid);
      if (blob) result.set(path, blob.data);
    }
  }
  for (const path of mbFiles.keys()) {
    if (!headFiles.has(path) && baseFiles.has(path) && mbFiles.get(path)?.oid === baseFiles.get(path)?.oid) result.delete(path);
    else if (!headFiles.has(path) && !baseFiles.has(path)) result.delete(path);
  }
  const message = `Squash merge #${pr.number}: ${pr.title}`;
  const sha = commitFiles(repo, pr.base, result, message, baseTip);
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed'; pr.merged = true; pr.mergeCommitSha = sha; pr.mergedAt = FIXED_TIME;
  return { ok: true, sha, message };
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const q = queryOf(req);
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  const segs = path.split('/').filter(Boolean); // api, v3, ...
  const rest = segs.slice(2);
  const hasBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let body: Record<string, unknown> = {};
  if (hasBody && rawBody.length > 0) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
    body = parsed.value;
  }
  // GET /api/v3/ and /api/v3
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    sendJson(res, 404, { message: 'Not Found' }); return;
  }
  if (rest[0] === 'meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }); return; }
  if (rest[0] === 'rate_limit' && method === 'GET') { sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 1700000000, used: 0 } }); return; }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, ownerUser()); return; }
    sendJson(res, 404, { message: 'Not Found' }); return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const { page, link } = paginate(all.map(repoJson), q, req, path);
      sendJson(res, 200, page, linkHeader(res, link)); return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return; }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) { sendJson(res, 422, { message: 'Repository already exists', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }); return; }
      const repo = newRepo(name, typeof body.description === 'string' ? body.description : null, body.private === true, typeof body.default_branch === 'string' ? body.default_branch : 'main');
      sendJson(res, 201, repoJson(repo)); return;
    }
    sendJson(res, 404, { message: 'Not Found' }); return;
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]); const name = decodeURIComponent(rest[2]);
    const repo = getRepo(owner, name);
    const sub = rest.slice(3);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
    // /repos/{o}/{r}
    if (sub.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string' || body.description === null) repo.description = body.description as string | null;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo)); return;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); sendNoContent(res, 204); return; }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // branches
    if (sub[0] === 'branches') {
      if (sub.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).sort().map(([n, oid]) => ({ name: n.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
        sendJson(res, 200, list); return;
      }
      if (sub.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(sub[1]);
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) { sendJson(res, 404, { message: 'Branch not found' }); return; }
        sendJson(res, 200, { name: branch, commit: { sha: oid, url: '' }, protected: false }); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // commits
    if (sub[0] === 'commits') {
      if (sub.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, q.get('sha') ?? '') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const out: Record<string, unknown>[] = [];
        if (tip) {
          const seen = new Set<string>(); const queue = [tip];
          while (queue.length && out.length < 100) {
            const oid = queue.shift()!;
            if (seen.has(oid)) continue; seen.add(oid);
            const obj = repo.objects.get(oid);
            if (!obj || obj.type !== 'commit') continue;
            const c = parseCommit(obj.data);
            out.push({ sha: oid, commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, tree: { sha: c.tree } }, author: ownerUser(), committer: ownerUser(), parents: c.parents.map((p) => ({ sha: p })) });
            for (const p of c.parents) queue.push(p);
          }
        }
        sendJson(res, 200, out); return;
      }
      if (sub.length === 2 && method === 'GET') {
        const oid = resolveRef(repo, decodeURIComponent(sub[1]));
        if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') { sendJson(res, 404, { message: 'Not Found' }); return; }
        const c = parseCommit(obj.data);
        sendJson(res, 200, { sha: oid, commit: { message: c.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_TIME }, tree: { sha: c.tree } }, author: ownerUser(), committer: ownerUser(), parents: c.parents.map((p) => ({ sha: p })) }); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // git refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'GET' && sub.length >= 3) {
        const refPath = sub.slice(2).map(decodeURIComponent).join('/');
        const full = `refs/${refPath}`;
        const oid = repo.refs.get(full);
        if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, { ref: full, node_id: `REF_${repo.id}_${full}`, url: '', object: { sha: oid, type: 'commit', url: '' } }); return;
      }
      if (method === 'GET' && sub.length === 2) {
        sendJson(res, 200, [...repo.refs.entries()].sort().map(([n, oid]) => ({ ref: n, node_id: `REF_${repo.id}_${n}`, url: '', object: { sha: oid, type: 'commit', url: '' } }))); return;
      }
      if (method === 'POST' && sub.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: `REF_${repo.id}_${ref}`, url: '', object: { sha, type: 'commit', url: '' } }); return;
      }
      if (method === 'PATCH' && sub.length >= 3) {
        const refPath = sub.slice(2).map(decodeURIComponent).join('/');
        const full = `refs/${refPath}`;
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!repo.refs.has(full) || !isOid(sha)) { sendJson(res, 404, { message: 'Not Found' }); return; }
        repo.refs.set(full, sha);
        sendJson(res, 200, { ref: full, node_id: `REF_${repo.id}_${full}`, url: '', object: { sha, type: 'commit', url: '' } }); return;
      }
      if (method === 'DELETE' && sub.length >= 3) {
        const refPath = sub.slice(2).map(decodeURIComponent).join('/');
        const full = `refs/${refPath}`;
        if (!repo.refs.has(full)) { sendJson(res, 404, { message: 'Not Found' }); return; }
        repo.refs.delete(full); sendNoContent(res, 204); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // contents
    if (sub[0] === 'contents') {
      const filePath = sub.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const at = treeAt(repo, q.get('ref') ?? undefined);
        if (!at) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const entry = contentEntry(repo, filePath, at.treeOid, q.get('ref') ?? undefined);
        if (!entry) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if ((entry as Record<string, unknown>).__dir) { sendJson(res, 200, (entry as unknown as { entries: unknown[] }).entries); return; }
        sendJson(res, 200, entry); return;
      }
      if (method === 'PUT') {
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const message = typeof body.message === 'string' ? body.message : 'Update';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        let branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (branchTip === undefined && branch !== repo.defaultBranch) {
          branchTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        }
        const files = filesAtTip(repo, branchTip ?? null);
        const exists = files.has(filePath);
        if (exists) {
          const currentBlob = hashObject('blob', files.get(filePath)!);
          if (typeof body.sha === 'string' && body.sha.toLowerCase() !== currentBlob.toLowerCase()) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return; }
        }
        let decoded: Buffer;
        try { decoded = Buffer.from(contentB64.replace(/\s/g, ''), 'base64'); } catch { sendJson(res, 422, { message: 'Invalid base64 content' }); return; }
        files.set(filePath, decoded);
        const commitSha = commitFiles(repo, branch, files, message, branchTip ?? null);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        const blobSha = hashObject('blob', decoded);
        sendJson(res, exists ? 200 : 201, { content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: decoded.length, type: 'file', encoding: 'base64', content: decoded.toString('base64'), url: '', git_url: '', html_url: '', download_url: '' }, commit: { sha: commitSha, message, author: ownerUser(), committer: ownerUser() } });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const branchTip = repo.refs.get(`refs/heads/${branch}`);
        if (!branchTip) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const files = filesAtTip(repo, branchTip);
        if (!files.has(filePath)) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (typeof body.sha === 'string') {
          const currentBlob = hashObject('blob', files.get(filePath)!);
          if (body.sha.toLowerCase() !== currentBlob.toLowerCase()) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return; }
        }
        files.delete(filePath);
        const message = typeof body.message === 'string' ? body.message : 'Delete';
        const commitSha = commitFiles(repo, branch, files, message, branchTip);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha, message } }); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // labels
    if (sub[0] === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()].map(labelJson)); return; }
      if (method === 'POST' && sub.length === 1) {
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { sendJson(res, 422, { message: 'Validation Failed' }); return; }
        const existing = repo.labels.get(name);
        if (existing) { sendJson(res, 200, labelJson(existing)); return; }
        const label: Label = { id: nextLabelId++, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label)); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
          list = [...list].sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          void sort;
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), q, req, path);
          sendJson(res, 200, page, linkHeader(res, link)); return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) { sendJson(res, 422, { message: 'Validation Failed: title is required' }); return; }
          const labelNames: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const l of body.labels as unknown[]) {
              if (typeof l === 'string') labelNames.push(l);
              else if (l !== null && typeof l === 'object') labelNames.push((l as Record<string, unknown>).name as string);
            }
          }
          const labels: Label[] = [];
          for (const ln of labelNames) {
            const found = repo.labels.get(ln);
            if (!found) { sendJson(res, 422, { message: `Validation Failed: label ${ln} does not exist` }); return; }
            labels.push(found);
          }
          repo.seq += 1;
          const issue: Issue = { id: nextGlobalId++, nodeId: `I_${repo.id}_${repo.nextIssue}`, number: repo.nextIssue++, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', labels, comments: [], seq: repo.seq };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue)); return;
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      const num = parseInt(sub[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (sub.length === 2) {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const labels: Label[] = [];
            for (const l of body.labels as unknown[]) {
              const ln = typeof l === 'string' ? l : (l as Record<string, unknown>).name as string;
              const found = repo.labels.get(ln);
              if (!found) { sendJson(res, 422, { message: `Validation Failed: label ${ln} does not exist` }); return; }
              labels.push(found);
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue)); return;
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      if (sub.length === 3 && sub[2] === 'comments') {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') { sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c))); return; }
        if (method === 'POST') {
          const b = typeof body.body === 'string' ? body.body : '';
          repo.seq += 1;
          const c: IssueComment = { id: nextGlobalId++, nodeId: `C_${repo.id}_${issue.number}_${issue.comments.length + 1}`, body: b, seq: repo.seq };
          issue.comments.push(c);
          sendJson(res, 201, commentJson(repo, issue, c)); return;
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    // pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => state === 'all' ? true : p.state === state);
          list = [...list].sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(list.map((p) => prJson(repo, p)), q, req, path);
          sendJson(res, 200, page, linkHeader(res, link)); return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head.split(':').pop()! : '';
          const base = typeof body.base === 'string' ? body.base.split(':').pop()! : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!title || !headSha || !baseSha) { sendJson(res, 422, { message: 'Validation Failed: head or base branch not found' }); return; }
          const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
          if (existing) { sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this branch' }); return; }
          repo.seq += 1;
          const pr: Pull = { id: nextGlobalId++, nodeId: `PR_${repo.id}_${repo.nextPull}`, number: repo.nextPull++, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeCommitSha: null, mergedAt: null, seq: repo.seq };
          repo.pulls.push(pr);
          sendJson(res, 201, prJson(repo, pr)); return;
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      const num = parseInt(sub[1], 10);
      const pr = repo.pulls.find((p) => p.number === num);
      if (sub.length === 2) {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') { sendJson(res, 200, prJson(repo, pr)); return; }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') pr.title = body.title;
          if (typeof body.body === 'string') pr.body = body.body;
          if (body.state === 'closed' && pr.state === 'open') pr.state = 'closed';
          sendJson(res, 200, prJson(repo, pr)); return;
        }
        sendJson(res, 404, { message: 'Not Found' }); return;
      }
      if (sub.length === 3 && sub[2] === 'files' && method === 'GET') {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
        sendJson(res, 200, prFiles(repo, pr)); return;
      }
      if (sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (pr.state !== 'open') { sendJson(res, 405, { message: 'Pull request is not open' }); return; }
        const result = doMerge(repo, pr);
        if (!result.ok) { sendJson(res, result.message === 'Merge conflict' ? 405 : 404, { message: result.message ?? 'Merge failed' }); return; }
        sendJson(res, 200, { sha: result.sha, merged: true, message: result.message }); return;
      }
      if (sub.length === 3 && sub[2] === 'commits' && method === 'GET') {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const out: Record<string, unknown>[] = [];
        const seen = new Set<string>(); const queue = [pr.headSha];
        const baseSet = new Set<string>();
        const bq = [pr.baseSha];
        while (bq.length) { const o = bq.pop()!; if (baseSet.has(o)) continue; baseSet.add(o); const ob = repo.objects.get(o); if (ob && ob.type === 'commit') for (const p of parseCommit(ob.data).parents) bq.push(p); }
        while (queue.length) {
          const oid = queue.shift()!;
          if (seen.has(oid) || baseSet.has(oid)) continue; seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const c = parseCommit(obj.data);
          out.push({ sha: oid, commit: { message: c.message } });
          for (const p of c.parents) queue.push(p);
        }
        sendJson(res, 200, out); return;
      }
      sendJson(res, 404, { message: 'Not Found' }); return;
    }
    sendJson(res, 404, { message: 'Not Found' }); return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------- GraphQL
type GqlValue = string | number | boolean | null | Record<string, unknown> | unknown[];
interface GqlSelection { alias: string; name: string; args: Record<string, GqlValue>; selections: GqlSelection[]; inlineType: string | null }
interface GqlOp { kind: 'query' | 'mutation'; name: string; selections: GqlSelection[] }
function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():!=$@[]'.includes(ch)) { tokens.push(ch); i++; continue; }
    if (ch === '"') {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; } }
      tokens.push(JSON.stringify(s)); i = j + 1; continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push(src.slice(i, j)); i = j; continue;
    }
    i++;
  }
  return tokens;
}
class GqlParser {
  tokens: string[]; pos = 0;
  constructor(src: string) { this.tokens = gqlTokenize(src); }
  peek(): string { return this.tokens[this.pos] ?? ''; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(variables: Record<string, unknown>): GqlValue {
    const t = this.next();
    if (t === '$') { const name = this.next(); return (variables[name] ?? null) as GqlValue; }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(variables); }
      this.expect('}'); return obj;
    }
    if (t === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue(variables));
      this.expect(']'); return arr;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    const n = Number(t);
    if (!Number.isNaN(n) && /^-?[0-9.]+$/.test(t)) return n;
    return t; // enum
  }
  parseSelections(variables: Record<string, unknown>): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek() !== '}' && this.pos < this.tokens.length) {
      if (this.peek() === '...') {
        this.next();
        let inlineType: string | null = null;
        if (this.peek() === 'on') { this.next(); inlineType = this.next(); }
        else { this.next(); } // fragment spread name, unsupported: skip its selections
        const inner = this.parseSelections(variables);
        for (const s of inner) sels.push({ ...s, inlineType });
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.parseValue(variables); }
        this.expect(')');
      }
      if (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') { let d = 0; while (this.pos < this.tokens.length) { const tk = this.next(); if (tk === '(') d++; if (tk === ')') { d--; if (d === 0) break; } } } }
      let sub: GqlSelection[] = [];
      if (this.peek() === '{') sub = this.parseSelections(variables);
      sels.push({ alias, name, args, selections: sub, inlineType: null });
    }
    this.expect('}');
    return sels;
  }
  parseDocument(variables: Record<string, unknown>): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.tokens.length) {
      let kind: 'query' | 'mutation' = 'query';
      let name = '';
      const t = this.peek();
      if (t === 'query' || t === 'mutation') { kind = t as 'query' | 'mutation'; this.next(); if (this.peek() !== '{' && this.peek() !== '(') name = this.next(); }
      else if (t === '{') { kind = 'query'; }
      else { this.next(); continue; }
      if (this.peek() === '(') {
        let d = 0;
        while (this.pos < this.tokens.length) { const tk = this.next(); if (tk === '(') d++; if (tk === ')') { d--; if (d === 0) break; } }
      }
      const selections = this.parseSelections(variables);
      ops.push({ kind, name, selections });
    }
    return ops;
  }
}
const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate'];
function gqlIssueValue(repo: Repo, issue: Issue, sel: GqlSelection, ctx: { errors: string[] }): unknown {
  switch (sel.name) {
    case 'id': return issue.nodeId;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'createdAt': case 'updatedAt': return FIXED_TIME;
    case 'author': return sel.selections.length ? resolveObject({ __type: 'User', login: VIEWER_LOGIN, id: 'U_1000' }, sel.selections, ctx) : { login: VIEWER_LOGIN };
    case 'comments': return { nodes: issue.comments.map((c) => ({ id: c.nodeId, body: c.body })) };
    default: ctx.errors.push(`Cannot query field "${sel.name}" on type "Issue".`); return null;
  }
}
function gqlPrValue(repo: Repo, pr: Pull, sel: GqlSelection, ctx: { errors: string[] }): unknown {
  switch (sel.name) {
    case 'id': return pr.nodeId;
    case 'number': return pr.number;
    case 'title': return pr.title;
    case 'body': return pr.body;
    case 'state': return pr.merged ? 'MERGED' : (pr.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'headRefName': return pr.head;
    case 'baseRefName': return pr.base;
    case 'headRefOid': return pr.headSha;
    case 'mergeable': return pr.state === 'open' ? (prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
    case 'merged': return pr.merged;
    case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`;
    case 'createdAt': case 'updatedAt': return FIXED_TIME;
    case 'author': return sel.selections.length ? resolveObject({ __type: 'User', login: VIEWER_LOGIN, id: 'U_1000' }, sel.selections, ctx) : { login: VIEWER_LOGIN };
    case 'files': {
      const files = prFiles(repo, pr);
      const first = typeof sel.args.first === 'number' ? sel.args.first : files.length;
      return { nodes: files.slice(0, first).map((f) => ({ path: f.filename, filename: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes, status: f.status.toUpperCase() })) };
    }
    default: ctx.errors.push(`Cannot query field "${sel.name}" on type "PullRequest".`); return null;
  }
}
function gqlCursor(n: number): string { return Buffer.from(`cursor:${n}`).toString('base64'); }
function gqlRepoValue(repo: Repo, sel: GqlSelection, ctx: { errors: string[] }): unknown {
  switch (sel.name) {
    case 'id': return repo.nodeId;
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return sel.selections.length ? resolveObject({ __type: 'User', login: repo.owner, id: 'U_1000' }, sel.selections, ctx) : { login: repo.owner };
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return sel.selections.length ? resolveObject({ __type: 'Ref', name: repo.defaultBranch, target: { oid: tip } }, sel.selections, ctx) : { name: repo.defaultBranch };
    }
    case 'viewerPermission': return 'WRITE';
    case 'hasIssuesEnabled': return true;
    case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'issue': {
      const num = sel.args.number as number;
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return null;
      return sel.selections.length ? resolveObject({ __type: 'Issue', __repo: repo, __issue: issue }, sel.selections, ctx) : issue.nodeId;
    }
    case 'issues': {
      let list = [...repo.issues];
      const states = sel.args.states as string[] | undefined;
      if (states && states.length) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
      const orderBy = sel.args.orderBy as Record<string, unknown> | undefined;
      if (orderBy && orderBy.field === 'CREATED_AT') {
        const dir = orderBy.direction === 'DESC' ? -1 : 1;
        list.sort((a, b) => dir * (a.seq - b.seq) || dir * (a.number - b.number));
      } else {
        list.sort((a, b) => a.seq - b.seq);
      }
      let start = 0;
      const after = sel.args.after as string | undefined;
      if (after) {
        try { const decoded = Buffer.from(after, 'base64').toString('utf8'); const m = decoded.match(/^cursor:(\d+)$/); if (m) start = parseInt(m[1], 10); } catch { /* ignore */ }
      }
      const first = typeof sel.args.first === 'number' ? sel.args.first : list.length;
      const sliced = list.slice(start, start + first);
      const nodes = sliced.map((i) => sel.selections.length ? resolveObject({ __type: 'Issue', __repo: repo, __issue: i }, nodeSelections(sel), ctx) : i.nodeId);
      const endCursor = sliced.length ? gqlCursor(start + sliced.length) : null;
      return { nodes, edges: sliced.map((i, idx) => ({ node: nodes[idx], cursor: gqlCursor(start + idx + 1) })), totalCount: list.length, pageInfo: { hasNextPage: start + sliced.length < list.length, endCursor, hasPreviousPage: start > 0, startCursor: sliced.length ? gqlCursor(start + 1) : null } };
    }
    case 'pullRequests': {
      const first = typeof sel.args.first === 'number' ? sel.args.first : repo.pulls.length;
      const list = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
      const nodes = list.map((p) => sel.selections.length ? resolveObject({ __type: 'PullRequest', __repo: repo, __pr: p }, nodeSelections(sel), ctx) : p.nodeId);
      return { nodes, edges: list.map((p, idx) => ({ node: nodes[idx], cursor: gqlCursor(idx + 1) })), totalCount: repo.pulls.length, pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } };
    }
    case 'pullRequest': {
      const num = sel.args.number as number;
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) return null;
      return sel.selections.length ? resolveObject({ __type: 'PullRequest', __repo: repo, __pr: pr }, sel.selections, ctx) : pr.nodeId;
    }
    default: ctx.errors.push(`Cannot query field "${sel.name}" on type "Repository".`); return null;
  }
}
function nodeSelections(sel: GqlSelection): GqlSelection[] {
  for (const s of sel.selections) if (s.name === 'nodes') return s.selections;
  return sel.selections;
}
function resolveObject(obj: Record<string, unknown>, selections: GqlSelection[], ctx: { errors: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = obj.__type as string;
  for (const sel of selections) {
    if (sel.name === '__typename') { out[sel.alias] = type; continue; }
    if (sel.name === '__type') { out[sel.alias] = introspectionType(sel.args.name as string, sel.selections, ctx); continue; }
    if (sel.inlineType && sel.inlineType !== type) continue;
    if (type === 'User') {
      if (sel.name === 'login') out[sel.alias] = obj.login;
      else if (sel.name === 'id') out[sel.alias] = obj.id;
      else if (sel.name === 'name') out[sel.alias] = VIEWER_NAME;
      else if (sel.name === 'email') out[sel.alias] = VIEWER_EMAIL;
      else { ctx.errors.push(`Cannot query field "${sel.name}" on type "User".`); out[sel.alias] = null; }
      continue;
    }
    if (type === 'Ref') {
      if (sel.name === 'name') out[sel.alias] = obj.name;
      else if (sel.name === 'target') {
        const target = obj.target as Record<string, unknown>;
        out[sel.alias] = sel.selections.length ? resolveObject({ __type: 'Commit', oid: target.oid }, sel.selections, ctx) : target;
      } else { ctx.errors.push(`Cannot query field "${sel.name}" on type "Ref".`); out[sel.alias] = null; }
      continue;
    }
    if (type === 'Commit') {
      if (sel.name === 'oid') out[sel.alias] = obj.oid;
      else if (sel.name === 'message') {
        const repo = obj.__repo as Repo | undefined;
        const c = repo?.objects.get(obj.oid as string);
        out[sel.alias] = c ? parseCommit(c.data).message : '';
      } else { ctx.errors.push(`Cannot query field "${sel.name}" on type "Commit".`); out[sel.alias] = null; }
      continue;
    }
    if (type === 'Issue') out[sel.alias] = gqlIssueValue(obj.__repo as Repo, obj.__issue as Issue, sel, ctx);
    else if (type === 'PullRequest') out[sel.alias] = gqlPrValue(obj.__repo as Repo, obj.__pr as Pull, sel, ctx);
    else if (type === 'Repository') out[sel.alias] = gqlRepoValue(obj.__repo as Repo, sel, ctx);
    else out[sel.alias] = null;
  }
  return out;
}
function introspectionType(name: string | undefined, selections: GqlSelection[], ctx: { errors: string[] }): Record<string, unknown> | null {
  const fieldsFor = (n: string): string[] => n === 'Issue' ? ISSUE_FIELDS : n === 'PullRequest' ? PR_FIELDS : n === 'Repository' ? REPO_FIELDS : [];
  const fieldObjs = (names: string[]) => names.map((n) => ({ name: n, description: null, args: [], type: { kind: 'SCALAR', name: 'String', ofType: null }, isDeprecated: false, deprecationReason: null }));
  let result: Record<string, unknown> | null = null;
  if (name === 'SearchType') {
    result = { name: 'SearchType', kind: 'ENUM', description: null, enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE'].map((n) => ({ name: n, description: null, isDeprecated: false, deprecationReason: null })), fields: null, inputFields: null, interfaces: [], possibleTypes: null };
  } else if (name === 'Issue' || name === 'PullRequest' || name === 'Repository') {
    result = { name, kind: 'OBJECT', description: null, fields: fieldObjs(fieldsFor(name)), enumValues: null, inputFields: null, interfaces: [], possibleTypes: null };
  } else if (name) {
    result = { name, kind: 'OBJECT', description: null, fields: fieldObjs([]), enumValues: null, inputFields: null, interfaces: [], possibleTypes: null };
  }
  if (!result) return null;
  // Only include requested subfields.
  const out: Record<string, unknown> = {};
  if (!selections.length) return result;
  for (const s of selections) {
    if (s.name === 'fields') out.fields = result.fields;
    else if (s.name === 'enumValues') out.enumValues = result.enumValues;
    else if (s.name === 'name') out.name = result.name;
    else if (s.name === 'kind') out.kind = result.kind;
    else out[s.alias] = result[s.name] ?? null;
  }
  return out;
}
function findByNodeId(id: string): { repo: Repo; kind: 'repo' | 'issue' | 'pr' | 'comment'; issue?: Issue; pr?: Pull } | null {
  if (id.startsWith('R_')) {
    const repoId = parseInt(id.slice(2), 10);
    const repo = [...repos.values()].find((r) => r.id === repoId);
    return repo ? { repo, kind: 'repo' } : null;
  }
  if (id.startsWith('I_')) {
    const parts = id.slice(2).split('_');
    const repo = [...repos.values()].find((r) => r.id === parseInt(parts[0], 10));
    const issue = repo?.issues.find((i) => i.number === parseInt(parts[1], 10));
    return repo && issue ? { repo, kind: 'issue', issue } : null;
  }
  if (id.startsWith('PR_')) {
    const parts = id.slice(3).split('_');
    const repo = [...repos.values()].find((r) => r.id === parseInt(parts[0], 10));
    const pr = repo?.pulls.find((p) => p.number === parseInt(parts[1], 10));
    return repo && pr ? { repo, kind: 'pr', pr } : null;
  }
  return null;
}
function executeGqlOp(op: GqlOp, ctx: { errors: string[] }): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.name === '__typename') { data[sel.alias] = op.kind === 'mutation' ? 'Mutation' : 'Query'; continue; }
    if (sel.name === '__type') { data[sel.alias] = introspectionType(sel.args.name as string, sel.selections, ctx); continue; }
    if (sel.name === '__schema') { data[sel.alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }; continue; }
    if (op.kind === 'mutation') {
      const input = (sel.args.input ?? {}) as Record<string, unknown>;
      if (sel.name === 'createIssue') {
        const found = findByNodeId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'repo') { ctx.errors.push('Repository not found'); data[sel.alias] = null; continue; }
        const repo = found.repo;
        repo.seq += 1;
        const issue: Issue = { id: nextGlobalId++, nodeId: `I_${repo.id}_${repo.nextIssue}`, number: repo.nextIssue++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], comments: [], seq: repo.seq };
        repo.issues.push(issue);
        data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'CreateIssuePayload', __repo: repo, __issue: issue }, sel.selections, ctx) : { issue: { number: issue.number, id: issue.nodeId } };
        continue;
      }
      if (sel.name === 'closeIssue') {
        const found = findByNodeId(String(input.issueId ?? ''));
        if (!found || found.kind !== 'issue' || !found.issue) { ctx.errors.push('Issue not found'); data[sel.alias] = null; continue; }
        found.issue.state = 'closed';
        data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'CloseIssuePayload', __repo: found.repo, __issue: found.issue }, sel.selections, ctx) : { issue: { number: found.issue.number, id: found.issue.nodeId, state: 'CLOSED' } };
        continue;
      }
      if (sel.name === 'createPullRequest') {
        const found = findByNodeId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'repo') { ctx.errors.push('Repository not found'); data[sel.alias] = null; continue; }
        const repo = found.repo;
        const head = String(input.headRefName ?? ''); const base = String(input.baseRefName ?? repo.defaultBranch);
        const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) { ctx.errors.push('Head or base branch not found'); data[sel.alias] = null; continue; }
        let pr = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
        if (!pr) {
          repo.seq += 1;
          pr = { id: nextGlobalId++, nodeId: `PR_${repo.id}_${repo.nextPull}`, number: repo.nextPull++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeCommitSha: null, mergedAt: null, seq: repo.seq };
          repo.pulls.push(pr);
        }
        data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'CreatePullRequestPayload', __repo: repo, __pr: pr }, sel.selections, ctx) : { pullRequest: { number: pr.number, id: pr.nodeId, state: 'OPEN' } };
        continue;
      }
      if (sel.name === 'mergePullRequest') {
        const found = findByNodeId(String(input.pullRequestId ?? ''));
        if (!found || found.kind !== 'pr' || !found.pr) { ctx.errors.push('Pull request not found'); data[sel.alias] = null; continue; }
        const pr = found.pr;
        if (pr.state === 'open') doMerge(found.repo, pr);
        data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'MergePullRequestPayload', __repo: found.repo, __pr: pr }, sel.selections, ctx) : { pullRequest: { number: pr.number, id: pr.nodeId, merged: pr.merged, state: 'MERGED' } };
        continue;
      }
      if (sel.name === 'addComment') {
        const found = findByNodeId(String(input.subjectId ?? ''));
        if (!found || found.kind !== 'issue' || !found.issue) { ctx.errors.push('Subject not found'); data[sel.alias] = null; continue; }
        const repo = found.repo; const issue = found.issue;
        repo.seq += 1;
        const c: IssueComment = { id: nextGlobalId++, nodeId: `C_${repo.id}_${issue.number}_${issue.comments.length + 1}`, body: String(input.body ?? ''), seq: repo.seq };
        issue.comments.push(c);
        data[sel.alias] = { commentEdge: { node: { id: c.nodeId, body: c.body } } };
        continue;
      }
      ctx.errors.push(`Cannot query field "${sel.name}" on type "Mutation".`);
      data[sel.alias] = null; continue;
    }
    // query root
    if (sel.name === 'viewer') {
      data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'User', login: VIEWER_LOGIN, id: 'U_1000' }, sel.selections, ctx) : { login: VIEWER_LOGIN };
      continue;
    }
    if (sel.name === 'repository') {
      const repo = getRepo(String(sel.args.owner ?? ''), String(sel.args.name ?? ''));
      if (!repo) { data[sel.alias] = null; continue; }
      data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'Repository', __repo: repo }, sel.selections, ctx) : repo.nodeId;
      continue;
    }
    if (sel.name === 'node') {
      const found = findByNodeId(String(sel.args.id ?? ''));
      if (!found) { data[sel.alias] = null; continue; }
      const obj: Record<string, unknown> = found.kind === 'repo' ? { __type: 'Repository', __repo: found.repo } : found.kind === 'issue' ? { __type: 'Issue', __repo: found.repo, __issue: found.issue } : { __type: 'PullRequest', __repo: found.repo, __pr: found.pr };
      data[sel.alias] = sel.selections.length ? resolveObject(obj, sel.selections, ctx) : null;
      continue;
    }
    if (sel.name === 'search') {
      data[sel.alias] = { nodes: [], edges: [], issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
      continue;
    }
    ctx.errors.push(`Cannot query field "${sel.name}" on type "Query".`);
    data[sel.alias] = null;
  }
  return data;
}
// Payload wrappers for mutations (resolve nested issue/pullRequest fields).
const _origResolve = resolveObject;
function resolvePayload(obj: Record<string, unknown>, selections: GqlSelection[], ctx: { errors: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.name === 'issue' && obj.__issue) {
      out[sel.alias] = sel.selections.length ? resolveObject({ __type: 'Issue', __repo: obj.__repo as Repo, __issue: obj.__issue as Issue }, sel.selections, ctx) : (obj.__issue as Issue).nodeId;
    } else if (sel.name === 'pullRequest' && obj.__pr) {
      out[sel.alias] = sel.selections.length ? resolveObject({ __type: 'PullRequest', __repo: obj.__repo as Repo, __pr: obj.__pr as Pull }, sel.selections, ctx) : (obj.__pr as Pull).nodeId;
    } else if (sel.name === 'commentEdge') {
      out[sel.alias] = { node: { id: (obj.__comment as IssueComment | undefined)?.nodeId ?? '', body: (obj.__comment as IssueComment | undefined)?.body ?? '' } };
    } else if (sel.name === 'clientMutationId') {
      out[sel.alias] = null;
    } else {
      out[sel.alias] = null;
      ctx.errors.push(`Cannot query field "${sel.name}" on mutation payload.`);
    }
  }
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody.toString('utf8')); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const results: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const d = doc as Record<string, unknown>;
    const query = typeof d.query === 'string' ? d.query : '';
    const variables = (d.variables ?? {}) as Record<string, unknown>;
    const ctx: { errors: string[] } = { errors: [] };
    let data: Record<string, unknown> | null = null;
    try {
      const parser = new GqlParser(query);
      const ops = parser.parseDocument(variables);
      const opName = typeof d.operationName === 'string' ? d.operationName : '';
      const op = (opName ? ops.find((o) => o.name === opName) : undefined) ?? ops[0];
      if (!op) { data = {}; }
      else {
        // Route payload types through resolvePayload.
        const patched = patchPayloadResolve(op, ctx);
        data = patched;
      }
    } catch {
      ctx.errors.push('GraphQL syntax error');
      data = {};
    }
    const result: Record<string, unknown> = { data: data ?? {} };
    if (ctx.errors.length) result.errors = ctx.errors.map((m) => ({ message: m }));
    results.push(result);
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}
function patchPayloadResolve(op: GqlOp, ctx: { errors: string[] }): Record<string, unknown> {
  // Execute with payload-aware resolution: temporarily wrap resolveObject calls for payload types.
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.name === '__typename') { data[sel.alias] = op.kind === 'mutation' ? 'Mutation' : 'Query'; continue; }
    if (sel.name === '__type') { data[sel.alias] = introspectionType(sel.args.name as string, sel.selections, ctx); continue; }
    if (sel.name === '__schema') { data[sel.alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }; continue; }
    if (op.kind === 'mutation') {
      const input = (sel.args.input ?? {}) as Record<string, unknown>;
      if (sel.name === 'createIssue') {
        const found = findByNodeId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'repo') { ctx.errors.push('Repository not found'); data[sel.alias] = null; continue; }
        const repo = found.repo;
        repo.seq += 1;
        const issue: Issue = { id: nextGlobalId++, nodeId: `I_${repo.id}_${repo.nextIssue}`, number: repo.nextIssue++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], comments: [], seq: repo.seq };
        repo.issues.push(issue);
        data[sel.alias] = sel.selections.length ? resolvePayload({ __type: 'CreateIssuePayload', __repo: repo, __issue: issue }, sel.selections, ctx) : { issue: { number: issue.number, id: issue.nodeId } };
        continue;
      }
      if (sel.name === 'closeIssue') {
        const found = findByNodeId(String(input.issueId ?? ''));
        if (!found || found.kind !== 'issue' || !found.issue) { ctx.errors.push('Issue not found'); data[sel.alias] = null; continue; }
        found.issue.state = 'closed';
        data[sel.alias] = sel.selections.length ? resolvePayload({ __type: 'CloseIssuePayload', __repo: found.repo, __issue: found.issue }, sel.selections, ctx) : { issue: { number: found.issue.number, id: found.issue.nodeId, state: 'CLOSED' } };
        continue;
      }
      if (sel.name === 'createPullRequest') {
        const found = findByNodeId(String(input.repositoryId ?? ''));
        if (!found || found.kind !== 'repo') { ctx.errors.push('Repository not found'); data[sel.alias] = null; continue; }
        const repo = found.repo;
        const head = String(input.headRefName ?? ''); const base = String(input.baseRefName ?? repo.defaultBranch);
        const headSha = repo.refs.get(`refs/heads/${head}`); const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) { ctx.errors.push('Head or base branch not found'); data[sel.alias] = null; continue; }
        let pr = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
        if (!pr) {
          repo.seq += 1;
          pr = { id: nextGlobalId++, nodeId: `PR_${repo.id}_${repo.nextPull}`, number: repo.nextPull++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeCommitSha: null, mergedAt: null, seq: repo.seq };
          repo.pulls.push(pr);
        }
        data[sel.alias] = sel.selections.length ? resolvePayload({ __type: 'CreatePullRequestPayload', __repo: repo, __pr: pr }, sel.selections, ctx) : { pullRequest: { number: pr.number, id: pr.nodeId, state: 'OPEN' } };
        continue;
      }
      if (sel.name === 'mergePullRequest') {
        const found = findByNodeId(String(input.pullRequestId ?? ''));
        if (!found || found.kind !== 'pr' || !found.pr) { ctx.errors.push('Pull request not found'); data[sel.alias] = null; continue; }
        const pr = found.pr;
        if (pr.state === 'open') doMerge(found.repo, pr);
        data[sel.alias] = sel.selections.length ? resolvePayload({ __type: 'MergePullRequestPayload', __repo: found.repo, __pr: pr }, sel.selections, ctx) : { pullRequest: { number: pr.number, id: pr.nodeId, merged: pr.merged, state: 'MERGED' } };
        continue;
      }
      if (sel.name === 'addComment') {
        const found = findByNodeId(String(input.subjectId ?? ''));
        if (!found || found.kind !== 'issue' || !found.issue) { ctx.errors.push('Subject not found'); data[sel.alias] = null; continue; }
        const repo = found.repo; const issue = found.issue;
        repo.seq += 1;
        const c: IssueComment = { id: nextGlobalId++, nodeId: `C_${repo.id}_${issue.number}_${issue.comments.length + 1}`, body: String(input.body ?? ''), seq: repo.seq };
        issue.comments.push(c);
        data[sel.alias] = { commentEdge: { node: { id: c.nodeId, body: c.body } } };
        continue;
      }
      ctx.errors.push(`Cannot query field "${sel.name}" on type "Mutation".`);
      data[sel.alias] = null; continue;
    }
    if (sel.name === 'viewer') { data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'User', login: VIEWER_LOGIN, id: 'U_1000' }, sel.selections, ctx) : { login: VIEWER_LOGIN }; continue; }
    if (sel.name === 'repository') {
      const repo = getRepo(String(sel.args.owner ?? ''), String(sel.args.name ?? ''));
      if (!repo) { data[sel.alias] = null; continue; }
      data[sel.alias] = sel.selections.length ? resolveObject({ __type: 'Repository', __repo: repo }, sel.selections, ctx) : repo.nodeId;
      continue;
    }
    if (sel.name === 'node') {
      const found = findByNodeId(String(sel.args.id ?? ''));
      if (!found) { data[sel.alias] = null; continue; }
      const obj: Record<string, unknown> = found.kind === 'repo' ? { __type: 'Repository', __repo: found.repo } : found.kind === 'issue' ? { __type: 'Issue', __repo: found.repo, __issue: found.issue } : { __type: 'PullRequest', __repo: found.repo, __pr: found.pr };
      data[sel.alias] = sel.selections.length ? resolveObject(obj, sel.selections, ctx) : null;
      continue;
    }
    if (sel.name === 'search') { data[sel.alias] = { nodes: [], edges: [], issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null } }; continue; }
    ctx.errors.push(`Cannot query field "${sel.name}" on type "Query".`);
    data[sel.alias] = null;
  }
  return data;
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: { name: string; description: string; inputSchema: { type: string; properties: Record<string, unknown>; required: string[] } }[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and repo name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = String(args.owner ?? args.owner_login ?? '');
  let repo = String(args.repo ?? args.repository ?? '');
  const full = String(args.full_name ?? args.fullName ?? '');
  if (full.includes('/')) { const parts = full.split('/'); if (!owner) owner = parts[0]; if (!repo) repo = parts[1]; }
  if (!repo && typeof args.name === 'string') repo = args.name;
  return { owner, repo };
}
function mcpCallTool(name: string, args: Record<string, unknown>): { isError?: boolean; result: unknown } {
  const key = name.toLowerCase();
  const match = MCP_TOOLS.find((t) => key === t.name || key.endsWith(`__${t.name}`) || key.endsWith(t.name));
  if (!match) return { result: { error: `Unknown tool: ${name}` }, isError: true };
  const toolName = match.name;
  if (toolName === 'create_repo') {
    const repoName = String(args.name ?? args.repo ?? '');
    if (!repoName) return { result: { error: 'Missing required argument: name' }, isError: true };
    if (repos.has(repoKey(VIEWER_LOGIN, repoName))) return { result: { error: 'Repository already exists' }, isError: true };
    const repo = newRepo(repoName, typeof args.description === 'string' ? args.description : null, args.private === true, 'main');
    return { result: repoJson(repo) };
  }
  const { owner, repo: repoName } = mcpOwnerRepo(args);
  if (toolName !== 'create_repo' && (!owner || !repoName)) return { result: { error: 'Missing required argument: owner/repo' }, isError: true };
  const repo = getRepo(owner, repoName);
  if (toolName === 'get_repo') {
    if (!repo) return { result: { error: 'Repository not found' }, isError: true };
    return { result: repoJson(repo) };
  }
  if (!repo) return { result: { error: 'Repository not found' }, isError: true };
  if (toolName === 'create_issue') {
    const title = String(args.title ?? args.issue_title ?? '');
    if (!title) return { result: { error: 'Missing required argument: title' }, isError: true };
    repo.seq += 1;
    const issue: Issue = { id: nextGlobalId++, nodeId: `I_${repo.id}_${repo.nextIssue}`, number: repo.nextIssue++, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], comments: [], seq: repo.seq };
    repo.issues.push(issue);
    return { result: issueJson(repo, issue) };
  }
  if (toolName === 'list_issues') {
    const state = String(args.state ?? 'open');
    const list = repo.issues.filter((i) => state === 'all' ? true : i.state === state).map((i) => issueJson(repo, i));
    return { result: { issues: list } };
  }
  if (toolName === 'create_pull_request') {
    const title = String(args.title ?? '');
    const head = String(args.head ?? args.head_branch ?? '').split(':').pop() ?? '';
    const base = String(args.base ?? args.base_branch ?? repo.defaultBranch).split(':').pop() ?? repo.defaultBranch;
    if (!title || !head || !base) return { result: { error: 'Missing required argument: title/head/base' }, isError: true };
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { result: { error: 'Head or base branch not found' }, isError: true };
    let pr = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
    if (!pr) {
      repo.seq += 1;
      pr = { id: nextGlobalId++, nodeId: `PR_${repo.id}_${repo.nextPull}`, number: repo.nextPull++, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', head, base, headSha, baseSha, merged: false, mergeCommitSha: null, mergedAt: null, seq: repo.seq };
      repo.pulls.push(pr);
    }
    return { result: prJson(repo, pr) };
  }
  if (toolName === 'merge_pull_request') {
    const num = Number(args.pull_number ?? args.number ?? args.pullNumber ?? NaN);
    if (!Number.isFinite(num)) return { result: { error: 'Missing required argument: pull_number' }, isError: true };
    const pr = repo.pulls.find((p) => p.number === num);
    if (!pr) return { result: { error: 'Pull request not found' }, isError: true };
    if (pr.state !== 'open') return { result: { error: 'Pull request is not open' }, isError: true };
    const result = doMerge(repo, pr);
    if (!result.ok) return { result: { error: result.message ?? 'Merge failed' }, isError: true };
    return { result: { sha: result.sha, merged: true, message: result.message, number: pr.number, full_name: `${repo.owner}/${repo.name}` } };
  }
  return { result: { error: 'Unknown tool' }, isError: true };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  let msg: Record<string, unknown>;
  try {
    const v = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    msg = v as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown): void => {
    if (id === null || id === undefined) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    if (id === null || id === undefined) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    reply({ protocolVersion: '2026-07-28', supportedVersions: ['2026-07-28'], serverInfo: { name: 'forge', version: '1.0.0' }, capabilities: { tools: {} } });
    return;
  }
  if (method === 'initialize') {
    const pv = String((params.protocolVersion as string | undefined) ?? '2026-07-28');
    reply({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } });
    return;
  }
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
  if (method === 'ping') { reply({}); return; }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }
  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const out = mcpCallTool(toolName, args);
    if (out.isError && typeof out.result === 'object' && out.result !== null && 'error' in (out.result as Record<string, unknown>) && String((out.result as Record<string, unknown>).error ?? '').startsWith('Unknown tool')) {
      replyError(-32602, `Unknown tool: ${toolName}`);
      return;
    }
    const text = JSON.stringify(out.result);
    reply({ content: [{ type: 'text', text }], structuredContent: out.result, isError: out.isError === true ? true : undefined });
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- app / server
export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const path = pathOf(req);
        if (path === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req, res, body); return; }
        if (path === '/mcp' && method === 'POST') { await handleMcp(req, res, body); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, body); return; }
        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]); const repoName = decodeURIComponent(gitMatch[2]);
          const repo = getRepo(owner, repoName);
          const q = queryOf(req);
          if (gitMatch[3] === 'info/refs' && method === 'GET') {
            const service = q.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'Missing service' }); return; }
            handleInfoRefs(req, res, repo, service); return;
          }
          if (gitMatch[3] === 'git-upload-pack' && method === 'POST') { await handleUploadPack(req, res, repo, body); return; }
          if (gitMatch[3] === 'git-receive-pack' && method === 'POST') { await handleReceivePack(req, res, repo, body); return; }
          sendJson(res, 404, { message: 'Not Found' }); return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else { try { res.end(); } catch { /* ignore */ } }
      }
    })();
  });
  return server;
}
