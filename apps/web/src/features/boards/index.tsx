'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type CSSProperties, type HTMLAttributes } from 'react';
import { Activity, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, Columns3, Copy, Download, ExternalLink, FileText, Grid2X2, Heart, LayoutDashboard, LockKeyhole, MessageCircle, MonitorPlay, MoreHorizontal, Plus, Printer, QrCode, RotateCcw, Search, Settings2, Share2, ShieldCheck, Star, Trash2, Users } from 'lucide-react';
import type { Board, BoardFormat, BoardView, PostDraft, PostView, Section, Share } from '@contracts';
import { api, EmptyState, Notice, Spinner } from '@ui';
import { ShareDialog } from '@features/share';
import { ParticipantsDialog } from '@features/participants';
import './boards.css';
import { Dialog } from './dialog';
import { BoardChrome } from './chrome';
import { DraftCompose } from './draft-compose';
import { Presentation } from './presentation';
import './workspace.css';
import { watchBoard } from '@features/live';

const labels: Record<Board['state'], string> = { draft: '준비 중', open: '참여 중', closed: '참여 종료', archived: '보관됨' };
const formats: { value: BoardFormat; label: string; description: string; icon: typeof Grid2X2 }[] = [
  { value: 'wall', label: '벽', description: '각자의 생각을 자유롭게 모아요', icon: LayoutDashboard },
  { value: 'grid', label: '격자', description: '카드를 가지런하게 살펴봐요', icon: Grid2X2 },
  { value: 'columns', label: '열', description: '주제별로 나누어 정리해요', icon: Columns3 },
];
const colors = ['#e9eee7', '#f4e6cd', '#e2eafa', '#f4e2e7', '#e5def3', '#dcf0ec'];
const stamp = (value: string) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));
const message = (error: unknown) => error instanceof Error ? error.message : '잠시 후 다시 시도해주세요.';
const body = (value: unknown) => JSON.stringify(value);


function CreateBoard({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [format, setFormat] = useState<BoardFormat>('wall'), [color, setColor] = useState(colors[0]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<BoardView>('/api/boards', { method: 'POST', body: body({ title, description, format, color }) }); window.location.assign(`/boards/${result.board.id}`); }
    catch (error) { setError(message(error)); setBusy(false); }
  };
  return <Dialog title="새로운 수업 공간 만들기" onClose={onClose} wide><p className="muted">작은 질문 하나로 시작해보세요. 준비가 되면 학생에게 열 수 있어요.</p><form onSubmit={submit} className="boards-form">
    <label className="field">게시판 이름<input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="예: 우리가 발견한 생태계" maxLength={200} required /></label>
    <label className="field">활동 안내<textarea className="textarea" value={description} onChange={event => setDescription(event.target.value)} placeholder="학생들에게 어떤 생각을 나누고 싶은지 알려주세요." maxLength={5000} rows={3} /></label>
    <fieldset className="boards-fieldset"><legend>생각을 모으는 방식</legend><div className="boards-format-options">{formats.map(item => <button type="button" key={item.value} aria-pressed={format === item.value} className={`boards-format-option ${format === item.value ? 'selected' : ''}`} onClick={() => setFormat(item.value)}><item.icon size={26} /><strong>{item.label}</strong><span>{item.description}</span></button>)}</div></fieldset>
    <fieldset className="boards-fieldset"><legend>게시판 색</legend><div className="boards-colors">{colors.map((value, index) => <button key={value} type="button" className={`boards-color${color === value ? ' selected' : ''}`} style={{ backgroundColor: value }} onClick={() => setColor(value)} aria-label={`게시판 색 ${index + 1}`} aria-pressed={color === value}>{color === value && <Check size={18} />}</button>)}</div></fieldset>
    {error && <Notice>{error}</Notice>}<div className="boards-dialog-actions"><button type="button" className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={busy}>{busy ? '만드는 중…' : '게시판 만들기'}<ArrowRight size={17} /></button></div>
  </form></Dialog>;
}

type ListBoard = Board & { favorite: boolean; post_count: number };
type BoardList = { boards: ListBoard[]; next_cursor: string | null };
export function Dashboard() {
  const [data, setData] = useState<BoardList | null>(null), [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'favorite' | 'trash'>('all');
  const [create, setCreate] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 250); return () => clearTimeout(timer); }, [query]);
  const load = useCallback(async (cursor?: string) => { const result = await api<BoardList>(`/api/boards?q=${encodeURIComponent(search)}&trash=${filter === 'trash'}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); setData(current => cursor && current ? { boards: [...current.boards, ...result.boards], next_cursor: result.next_cursor } : result); }, [search, filter]);
  useEffect(() => { let active = true; setError(''); setData(null); api<BoardList>(`/api/boards?q=${encodeURIComponent(search)}&trash=${filter === 'trash'}`).then(result => { if (active) setData(result); }).catch(error => { if (active) setError(message(error)); }); return () => { active = false; }; }, [search, filter]);
  const action = async (board: ListBoard, kind: 'favorite' | 'restore' | 'delete') => {
    if (kind === 'delete' && !window.confirm(`“${board.title}” 게시판을 휴지통으로 옮길까요? 학생 접근도 중지됩니다.`)) return;
    setPending(board.id); setError('');
    try { await api(`/api/boards/${board.id}${kind === 'delete' ? '' : `/${kind}`}`, { method: kind === 'favorite' ? 'PUT' : kind === 'delete' ? 'DELETE' : 'POST', body: body(kind === 'favorite' ? { favorite: !board.favorite } : { version: board.version }) }); await load(); } catch (error) { setError(message(error)); } finally { setPending(''); }
  };
  const list = data?.boards.filter(board => filter !== 'favorite' || board.favorite) ?? [];
  return <main className="boards-dashboard" data-library="true">
    <aside className="boards-library-sidebar"><h2>내 공간</h2><div className="boards-tabs" role="group" aria-label="게시판 분류"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><LayoutDashboard size={16} />전체 게시판</button><button className={filter === 'favorite' ? 'active' : ''} onClick={() => setFilter('favorite')}><Star size={16} />즐겨찾기</button><button className={filter === 'trash' ? 'active' : ''} onClick={() => setFilter('trash')}><Trash2 size={16} />휴지통</button></div><p>모아 · 삼정중학교<br />수업 게시판</p></aside>
    <section className="boards-library-main">
    <div className="page-header"><div><h1>{filter === 'trash' ? '휴지통' : filter === 'favorite' ? '즐겨찾기' : '내 게시판'}{' '}<span className="board-library-total">{list.length}</span></h1></div><div className="board-library-tools"><label className="boards-search"><Search size={18} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="게시판 검색" placeholder="게시판 검색" /></label><button className="button primary" onClick={() => setCreate(true)}><Plus size={19} />만들기</button></div></div>
    {error && <Notice>{error}</Notice>}{!data && !error && <Spinner />}
    {data && <div className="boards-library">{list.map(board => <article className="boards-library-card card" key={board.id}>
      {filter === 'trash' ? <div className="boards-cover" style={{ backgroundColor: board.color }}><Trash2 size={35} /><span>휴지통</span></div> : <a href={`/boards/${board.id}`} className={`boards-cover boards-cover-${board.format}`} style={{ backgroundColor: board.color }} aria-label={`${board.title} 열기`}><div className="boards-miniature" aria-hidden="true">{[0, 1, 2, 3, 4].map(i => <div key={i}><i /><b /><b /></div>)}</div><span className={`badge state-${board.state}`}><i />{labels[board.state]}</span></a>}
      <div className="boards-library-card-body"><div className="boards-card-title">{filter === 'trash' ? <h3>{board.title}</h3> : <h3><a href={`/boards/${board.id}`}>{board.title}</a></h3>}<button className={`button ghost icon-button ${board.favorite ? 'favorite' : ''}`} aria-label={board.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가'} disabled={!!pending || filter === 'trash'} onClick={() => void action(board, 'favorite')}><Star size={18} fill={board.favorite ? 'currentColor' : 'none'} /></button></div><p>{board.description || '함께 생각을 나누는 새로운 수업 공간'}</p><div className="boards-card-meta"><span><FileText size={14} />{board.post_count}개의 생각</span><span>{formats.find(item => item.value === board.format)?.label}</span></div><div className="boards-card-footer"><small>{stamp(board.updated_at)} 수정</small>{filter === 'trash' ? <button className="button ghost" disabled={!!pending} onClick={() => void action(board, 'restore')}>복원하기</button> : <button className="button ghost icon-button" title="휴지통으로 이동 (소유 교사)" aria-label={`${board.title} 휴지통으로 이동`} disabled={!!pending} onClick={() => void action(board, 'delete')}><Trash2 size={15} /></button>}</div></div>
    </article>)}{filter === 'all' && !search && <button className="boards-create-card" onClick={() => setCreate(true)}><span><Plus size={25} /></span><strong>새로운 생각을 모아볼까요?</strong><small>나만의 수업 게시판 만들기</small></button>}</div>}
    {data && !list.length && (filter !== 'all' || !!search) && <EmptyState title={filter === 'trash' ? '휴지통이 비어 있어요' : filter === 'favorite' ? '자주 쓰는 게시판에 별을 달아주세요' : '검색한 게시판이 없어요'}>다른 검색어를 입력하거나 새로운 게시판을 만들어보세요.</EmptyState>}
    {data?.next_cursor && <div className="boards-load-more"><button className="button secondary" onClick={() => void load(data.next_cursor!).catch(error => setError(message(error)))}>더 보기<ChevronDown size={16} /></button></div>}
    {create && <CreateBoard onClose={() => setCreate(false)} />}
    </section>
  </main>;
}

function Settings({ view, onClose, onSaved }: { view: BoardView; onClose: () => void; onSaved: (view: BoardView) => void }) {
  const [form, setForm] = useState(view.board), [email, setEmail] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [success, setSuccess] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { onSaved(await api<BoardView>(`/api/boards/${view.board.id}`, { method: 'PATCH', body: body({ title: form.title, description: form.description, format: form.format, participation_mode: form.participation_mode, moderation: form.moderation, allow_comments: form.allow_comments, allow_reactions: form.allow_reactions, anonymous_display: form.anonymous_display, color: form.color, column_width: form.column_width, font_scale: form.font_scale, card_density: form.card_density, background_style: form.background_style, version: view.board.version }) })); onClose(); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const invite = async () => { setBusy(true); setError(''); try { await api(`/api/boards/${view.board.id}/members`, { method: 'POST', body: body({ email }) }); setSuccess('공동 편집 교사를 초대했어요.'); setEmail(''); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  return <Dialog title="수업 공간 설정" onClose={onClose} variant="settings"><form className="boards-form" onSubmit={submit}>
    <label className="field">게시판 이름<input className="input" required maxLength={200} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></label><label className="field">활동 안내<textarea className="textarea" maxLength={5000} rows={3} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
    <div className="boards-form-row"><label className="field">배치 방식<select className="select" value={form.format} onChange={event => setForm({ ...form, format: event.target.value as BoardFormat })}>{formats.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field">학생 참여<select className="select" value={form.participation_mode} onChange={event => setForm({ ...form, participation_mode: event.target.value as Board['participation_mode'] })}><option value="both">로그인 또는 익명</option><option value="login">Google 로그인 필수</option></select></label></div>
    {([{ key: 'moderation', title: '교사 승인 후 공개', detail: '새 글과 수정 글을 먼저 확인해요.' }, { key: 'allow_comments', title: '댓글 허용', detail: '서로의 생각에 이야기를 이어가요.' }, { key: 'allow_reactions', title: '좋아요 허용', detail: '마음에 드는 생각에 공감해요.' }, { key: 'anonymous_display', title: '학생에게 작성자 이름 숨기기', detail: '로그인 여부와 별개이며 교사에게는 이름이 보여요.' }] as const).map(item => <label className="boards-switch-row" key={item.key}><span><strong>{item.title}</strong><small>{item.detail}</small></span><input type="checkbox" role="switch" checked={form[item.key]} onChange={event => setForm({ ...form, [item.key]: event.target.checked })} /></label>)}
    <fieldset className="boards-fieldset"><legend>외형</legend>
      <div className="boards-form-row"><label className="field">배경 색<input type="color" value={form.color} onChange={event => setForm({ ...form, color: event.target.value })} /></label><label className="field">배경 스타일<select className="select" value={form.background_style ?? 'gradient'} onChange={event => setForm({ ...form, background_style: event.target.value as Board['background_style'] })}><option value="gradient">은은한 빛</option><option value="solid">단색</option><option value="paper">줄 노트</option></select></label></div>
      <label className="field">열 너비 {form.column_width ?? 300}px<input type="range" min={260} max={440} step={20} value={form.column_width ?? 300} onChange={event => setForm({ ...form, column_width: Number(event.target.value) })} /></label>
      <div className="boards-form-row"><label className="field">글자 크기<select className="select" value={form.font_scale ?? 'normal'} onChange={event => setForm({ ...form, font_scale: event.target.value as Board['font_scale'] })}><option value="small">작게</option><option value="normal">보통</option><option value="large">크게 (프로젝터)</option></select></label><label className="field">카드 간격<select className="select" value={form.card_density ?? 'comfortable'} onChange={event => setForm({ ...form, card_density: event.target.value as Board['card_density'] })}><option value="comfortable">여유 있게</option><option value="compact">촘촘하게</option></select></label></div>
    </fieldset>
    {error && <Notice>{error}</Notice>}<div className="boards-dialog-actions"><button className="button secondary" type="button" onClick={onClose}>취소</button><button className="button primary" disabled={busy}>설정 저장</button></div>
  </form>{view.principal.id === view.board.owner_id && <div className="boards-invite"><h3><Users size={18} />함께 수업하는 선생님</h3><p className="muted">먼저 로그인한 학교 교사를 공동 편집자로 초대해요.</p><label className="field">교사 이메일<input className="input" type="email" value={email} placeholder="teacher@samjeong.ms.kr" onChange={event => setEmail(event.target.value)} /></label><button className="button secondary" disabled={busy || !email} onClick={() => void invite()}>편집자로 초대</button>{success && <p role="status">{success}</p>}</div>}</Dialog>;
}

function ActivityPanel({ view, onClose }: { view: BoardView; onClose: () => void }) {
  // Derived from the permission-filtered BoardView only; no extra data is fetched.
  const items = view.posts.flatMap(post => [
    { id: `post-${post.id}`, post, at: post.created_at, text: `${post.author_name}님이 글을 올렸어요` },
    ...post.comments.map(item => ({ id: `comment-${item.id}`, post, at: item.created_at, text: `${item.author_name}님이 댓글을 남겼어요` })),
  ]).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const jump = (postId: string) => { onClose(); setTimeout(() => document.getElementById(`post-${postId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0); };
  return <Dialog title="최근 활동" onClose={onClose} variant="settings">
    {items.length ? <ol className="board-activity">{items.map(item => <li key={item.id}><button type="button" onClick={() => jump(item.post.id)}><strong>{item.text}</strong><span>{item.post.title}{item.post.status === 'pending' ? ' · 승인 대기' : ''}</span><time dateTime={item.at}>{stamp(item.at)}</time></button></li>)}</ol> : <p className="muted">아직 활동이 없어요.</p>}
  </Dialog>;
}

function PostCard({ post, view, onEdit, onChange, onShare, drag }: { post: PostView; view: BoardView; onEdit: () => void; onChange: (view: BoardView) => void; onShare: () => void; drag?: HTMLAttributes<HTMLElement> }) {
  const [expanded, setExpanded] = useState(view.board.allow_comments || post.comments.length > 0), [comment, setComment] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [commentKey, setCommentKey] = useState(() => crypto.randomUUID());
  const mutate = async (path: string, method: string, value: unknown, headers?: HeadersInit) => { setBusy(true); setError(''); try { onChange(await api<BoardView>(path, { method, body: body(value), headers })); return true; } catch (error) { setError(message(error)); return false; } finally { setBusy(false); } };
  const moderate = (status: 'published' | 'hidden' | 'rejected') => void mutate(`/api/posts/${post.id}/moderation`, 'POST', { version: post.version, status });
  const remove = () => { if (window.confirm('이 글을 삭제할까요?')) void mutate(`/api/posts/${post.id}`, 'DELETE', { version: post.version }); };
  const submitComment = async (event: FormEvent) => { event.preventDefault(); if (await mutate(`/api/posts/${post.id}/comments`, 'POST', { body: comment }, { 'Idempotency-Key': commentKey })) { setComment(''); setCommentKey(crypto.randomUUID()); } };
  const status = { pending: '승인 대기', rejected: '다시 확인해주세요', hidden: '숨긴 글', deleted: '삭제됨', published: '' }[post.status];
  return <article id={`post-${post.id}`} className={`card boards-post boards-post-${post.status}`} style={{ backgroundColor: post.color }} {...drag}>
    <div className="boards-post-author"><span className="boards-avatar">{post.is_mine ? '나' : post.author_name.slice(0, 1)}</span><div><strong>{post.author_name}{post.is_mine && <span className="boards-mine">내 글</span>}</strong><small>{stamp(post.updated_at)}</small></div>{(view.can_manage || post.can_edit) && <details className="boards-more board-post-menu"><summary className="button ghost icon-button" aria-label={`${post.title} 게시물 작업`}><MoreHorizontal size={20} /></summary><div>
      {post.can_edit && <><button onClick={onEdit}>게시물 수정</button><button aria-label="글 삭제" disabled={busy} onClick={remove}><Trash2 size={15} />게시물 삭제</button></>}
      {view.can_manage && <><button aria-label={`${post.title} QR 공유`} onClick={onShare}><QrCode size={16} />게시물 QR 공유</button><button aria-label="글 앞으로 이동" disabled={busy} onClick={() => void mutate(`/api/posts/${post.id}/order`, 'POST', { direction: 'up', version: post.version })}><ArrowUp size={15} />앞으로 이동</button><button aria-label="글 뒤로 이동" disabled={busy} onClick={() => void mutate(`/api/posts/${post.id}/order`, 'POST', { direction: 'down', version: post.version })}><ArrowDown size={15} />뒤로 이동</button>{post.status !== 'published' && <button disabled={busy} onClick={() => moderate('published')}>공개 승인</button>}{post.status === 'pending' && <button disabled={busy} onClick={() => moderate('rejected')}>반려</button>}{post.status === 'published' && <button disabled={busy} onClick={() => moderate('hidden')}>숨기기</button>}</>}
    </div></details>}</div>
    {status && <span className={`badge post-state-${post.status}`}>{status}</span>}<h3>{post.title}</h3><p className="boards-post-text">{post.body}</p>
    {post.link && <a className="boards-post-link" href={post.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /><span>{post.link.replace(/^https?:\/\//, '')}</span></a>}
    {post.attachments.map(file => <div className="boards-file-preview" key={file.id}>{file.mime.startsWith('image/') && <a href={`/api/attachments/${file.id}/content`} target="_blank" rel="noopener noreferrer"><img className="boards-post-image" src={`/api/attachments/${file.id}/content`} alt={file.name} loading="lazy" /></a>}<a className="boards-attachment-link" href={`/api/attachments/${file.id}/content`} target="_blank" rel="noopener noreferrer"><FileText size={18} /><span>{file.name}<small>{Math.max(1, Math.round(file.bytes / 1024))}KB</small></span><Download size={16} /></a></div>)}
    <div className="boards-post-tools"><div>{view.board.allow_reactions && <button className={`button ghost${post.liked ? ' liked' : ''}`} aria-label={post.liked ? '좋아요 취소' : '좋아요'} aria-pressed={post.liked} disabled={!view.can_write || busy} onClick={() => void mutate(`/api/posts/${post.id}/reaction`, 'PUT', { liked: !post.liked })}><Heart size={17} fill={post.liked ? 'currentColor' : 'none'} />{post.likes || ''}</button>}<button className="button ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><MessageCircle size={17} />{post.comments.length || ''}<span className="sr-only">댓글</span></button></div></div>

    {expanded && <div className="boards-comments">{post.comments.map(item => <div className="boards-comment" key={item.id}><strong>{item.author_name}</strong><p>{item.body}</p><small>{stamp(item.created_at)}</small></div>)}{view.can_write && view.board.allow_comments ? <form onSubmit={submitComment}><label className="sr-only" htmlFor={`comment-${post.id}`}>댓글 내용</label><input id={`comment-${post.id}`} className="input" required maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="따뜻한 피드백을 남겨요" /><button className="button primary icon-button" aria-label="댓글 등록" disabled={busy}><ArrowRight size={17} /></button></form> : <p className="muted">지금은 댓글을 작성할 수 없어요.</p>}</div>}{error && <Notice>{error}</Notice>}
  </article>;
}

export function BoardWorkspace({ boardId, postId, sectionId, submission = false }: { boardId: string; postId?: string; sectionId?: string; submission?: boolean }) {
  const [view, setView] = useState<BoardView | null>(null), [error, setError] = useState(''), [connected, setConnected] = useState(false), [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState(false), [editing, setEditing] = useState<PostView | undefined>(), [settings, setSettings] = useState(false), [moderationOnly, setModerationOnly] = useState(false), [query, setQuery] = useState('');
  const [share, setShare] = useState<{ type: Share['target_type']; target: string; title: string } | null>(null), [addSection, setAddSection] = useState(false), [sectionTitle, setSectionTitle] = useState(''), [sectionEditing, setSectionEditing] = useState<string | null>(null), [composeSection, setComposeSection] = useState<string | undefined>(sectionId), [participants, setParticipants] = useState(false);
  const [drafts, setDrafts] = useState<PostDraft[]>([]), [draftId, setDraftId] = useState<string>(), [presenting, setPresenting] = useState<string | null>(null);
  const [activity, setActivity] = useState(false), [dragging, setDragging] = useState<{ kind: 'post' | 'section'; id: string } | null>(null), [dropTarget, setDropTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Section | null>(null), [moveTo, setMoveTo] = useState(''), [insert, setInsert] = useState<{ before_id?: string; after_id?: string }>({});
  const generation = useRef(0), canWrite = view?.can_write;
  const loadDrafts = useCallback(() => { api<PostDraft[]>(`/api/boards/${boardId}/drafts`).then(setDrafts).catch(() => setDrafts([])); }, [boardId]);
  useEffect(() => { if (canWrite) loadDrafts(); }, [canWrite, loadDrafts]);
  const refresh = useCallback(async () => { const current = ++generation.current; try { const next = await api<BoardView>(`/api/boards/${boardId}`); if (current === generation.current) { setView(next); setError(''); } } catch (error) { if (current === generation.current) { setError(message(error)); setView(null); } } }, [boardId]);
  useEffect(() => { void refresh(); const stop = watchBoard(boardId, refresh, setConnected); const cancelRequests = () => { ++generation.current; }; return () => { cancelRequests(); stop(); }; }, [boardId, refresh]);
  const closeCompose = useCallback(() => { setCompose(false); setEditing(undefined); setDraftId(undefined); loadDrafts(); }, [loadDrafts]);
  const minimize = (draft: PostDraft) => { setCompose(false); setEditing(undefined); setDraftId(undefined); setDrafts(current => [draft, ...current.filter(item => item.id !== draft.id)]); };
  const openSection = (position: { before_id?: string; after_id?: string } = {}, target?: Section) => { setInsert(position); setSectionEditing(target?.id ?? null); setSectionTitle(target?.title ?? ''); setAddSection(true); };
  const accept = (next: BoardView) => { ++generation.current; setView(next); };
  const changeState = async () => { if (!view) return; setBusy(true); setError(''); try { accept(await api<BoardView>(`/api/boards/${boardId}`, { method: 'PATCH', body: body({ state: view.board.state === 'open' ? 'closed' : 'open', version: view.board.version }) })); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const duplicate = async (includePosts = false) => { setBusy(true); try { const next = await api<BoardView>(`/api/boards/${boardId}/duplicate`, { method: 'POST', body: body({ include_posts: includePosts }) }); window.location.assign(`/boards/${next.board.id}`); } catch (error) { setError(message(error)); setBusy(false); } };
  const newSection = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { accept(await api<BoardView>(`/api/boards/${boardId}/sections${sectionEditing ? `/${sectionEditing}` : ''}`, { method: sectionEditing ? 'PATCH' : 'POST', body: body({ title: sectionTitle, ...(sectionEditing ? {} : insert) }) })); setSectionTitle(''); setSectionEditing(null); setAddSection(false); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const moveSection = async (section: string, direction: 'up' | 'down') => { if (!view) return; setBusy(true); setError(''); try { accept(await api<BoardView>(`/api/boards/${boardId}/sections/${section}/order`, { method: 'POST', body: body({ direction, version: view.board.version }) })); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const removeSection = async (event: FormEvent) => { event.preventDefault(); if (!view || !removing) return; setBusy(true); setError(''); try { accept(await api<BoardView>(`/api/boards/${boardId}/sections/${removing.id}`, { method: 'DELETE', body: body({ version: view.board.version, move_to: moveTo || null }) })); setRemoving(null); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const restoreSection = async (section: string) => { if (!view) return; setBusy(true); setError(''); try { accept(await api<BoardView>(`/api/boards/${boardId}/sections/${section}/restore`, { method: 'POST', body: body({ version: view.board.version }) })); setAddSection(false); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const run = async (request: () => Promise<BoardView>) => { setBusy(true); setError(''); try { accept(await request()); } catch (error) { setError(message(error)); } finally { setBusy(false); } };
  const endDrag = () => { setDragging(null); setDropTarget(null); };
  // Drag is a teacher-only alternative to the move buttons; the server re-validates the full order and version.
  const drop = (sectionId: string, beforePostId?: string) => {
    const current = dragging; endDrag();
    if (!view || !current || current.id === beforePostId) return;
    if (current.kind === 'section') {
      if (current.id === sectionId) return;
      const ids = view.sections.map(item => item.id).filter(item => item !== current.id);
      ids.splice(ids.indexOf(sectionId), 0, current.id);
      return void run(() => api<BoardView>(`/api/boards/${boardId}/sections/reorder`, { method: 'POST', body: body({ version: view.board.version, section_ids: ids }) }));
    }
    const moving = view.posts.find(post => post.id === current.id);
    if (!moving) return;
    const siblings = view.posts.filter(post => post.section_id === sectionId && post.id !== moving.id);
    const found = beforePostId ? siblings.findIndex(post => post.id === beforePostId) : -1, index = found < 0 ? siblings.length : found;
    if (moving.section_id === sectionId) {
      const ids = siblings.map(post => post.id); ids.splice(index, 0, moving.id);
      return void run(() => api<BoardView>(`/api/boards/${boardId}/posts/reorder`, { method: 'POST', body: body({ version: view.board.version, section_id: sectionId, post_ids: ids }) }));
    }
    // ponytail: rank just before the drop target can tie with its neighbour (then created_at decides); reorder normalizes ranks.
    const rank = index < siblings.length ? Math.max(0, siblings[index].rank - 1) : (siblings.at(-1)?.rank ?? 0) + 100;
    void run(() => api<BoardView>(`/api/posts/${moving.id}`, { method: 'PATCH', body: body({ version: moving.version, section_id: sectionId, rank }) }));
  };
  const askRemove = (section: Section) => { setMoveTo(''); setError(''); setRemoving(section); };
  if (!view) return <main className="boards-workspace">{error ? <><Notice>{error}</Notice><button className="button secondary" onClick={() => void refresh()}>다시 불러오기</button></> : <Spinner />}</main>;
  const posts = view.posts.filter(post => (!submission || view.can_manage || post.is_mine) && (!postId || post.id === postId) && (!sectionId || post.section_id === sectionId) && (!moderationOnly || post.status === 'pending') && (!query || `${post.title} ${post.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const visibleSections = view.sections.filter(item => !sectionId || item.id === sectionId);
  const countPending = view.posts.filter(post => post.status === 'pending').length;
  const canCompose = view.can_write && (view.can_manage || !postId);
  const draggable = view.can_manage && view.board.format === 'columns' && !busy;
  const postDrag = (post: PostView): HTMLAttributes<HTMLElement> | undefined => draggable ? {
    draggable: true,
    onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', post.id); setDragging({ kind: 'post', id: post.id }); },
    onDragEnd: endDrag,
    onDragOver: event => { if (dragging?.kind === 'post') { event.preventDefault(); event.stopPropagation(); setDropTarget(post.section_id); } },
    onDrop: event => { if (dragging?.kind === 'post') { event.preventDefault(); event.stopPropagation(); drop(post.section_id ?? '', post.id); } },
  } : undefined;
  const renderPost = (post: PostView) => <PostCard key={post.id} drag={postDrag(post)} post={post} view={view} onEdit={() => { setEditing(post); setDraftId(drafts.find(draft => draft.edit_post_id === post.id)?.id); setCompose(true); }} onChange={accept} onShare={() => setShare({ type: 'post', target: post.id, title: post.title })} />;
  return <main className="boards-workspace" data-ready="true" data-dragging={dragging?.kind} data-font={view.board.font_scale ?? 'normal'} data-density={view.board.card_density ?? 'comfortable'} data-background={view.board.background_style ?? 'gradient'} style={{ '--board-background': view.board.color, '--board-column': `${view.board.column_width ?? 300}px` } as CSSProperties}>

    <BoardChrome principal={view.principal} query={query} onQuery={setQuery}>
      <button className="button ghost icon-button" aria-label="최근 활동" title="최근 활동" onClick={() => setActivity(true)}><Activity size={20} /></button>
      {view.can_manage && <>
        <button className="button board-share" onClick={() => setShare({ type: submission ? 'submission' : 'board', target: boardId, title: view.board.title })}><Share2 size={19} /><span>공유</span></button>
        <div className="board-control-group">
          <button className="button ghost icon-button" aria-label="게시판 설정" title="게시판 설정" onClick={() => setSettings(true)}><Settings2 size={20} /></button>
          <button className="button ghost icon-button" aria-label="참여 관리" title="참여 관리" onClick={() => setParticipants(true)}><Users size={20} /></button>
          <button className={`button ghost icon-button ${moderationOnly ? 'active' : ''}`} aria-label={`승인 대기 ${countPending}`} aria-pressed={moderationOnly} title="승인 대기 글 보기" onClick={() => setModerationOnly(!moderationOnly)}><CheckCheck size={20} />{!!countPending && <span className="board-pending-count">{countPending}</span>}</button>
          <details className="boards-more"><summary className="button ghost"><MoreHorizontal size={19} /><span className="sr-only">추가 도구</span></summary><div><button onClick={() => setPresenting('')}><MonitorPlay size={16} />발표 모드</button><a href={`/api/boards/${boardId}/export`}><Download size={16} />CSV 내보내기</a><button onClick={() => window.print()}><Printer size={16} />인쇄 · PDF 저장</button><button disabled={busy} onClick={() => void duplicate()}><Copy size={16} />설정과 섹션 복제</button><button disabled={busy} title="공개 글의 텍스트와 링크를 복제해요. 파일과 댓글은 포함되지 않아요." onClick={() => void duplicate(true)}><Copy size={16} />공개 글 포함 복제</button><small className="boards-duplicate-help">글 복제에 파일 · 댓글은 포함되지 않아요.</small><button disabled={busy} onClick={() => void changeState()}><LockKeyhole size={16} />{view.board.state === 'open' ? '참여 종료하기' : '참여 열기'}</button><button onClick={() => setShare({ type: 'submission', target: boardId, title: `${view.board.title} · 제출` })}><FileText size={16} />제출 페이지 QR</button></div></details>
        </div>
      </>}
    </BoardChrome>
    <header className="board-heading">
      <div className="board-heading-meta"><span>{view.principal.display_name}</span><span>·</span><span>{labels[view.board.state]}</span><span className="boards-connection" role="status" title={connected ? '실시간 연결됨' : '연결 확인 중'}><i className={connected ? 'connected' : ''} /><span className="sr-only">{connected ? '실시간 연결됨' : '연결 확인 중'}</span></span>{view.board.moderation && <span>승인 후 공개</span>}{(view.submission_only || submission) && <span>나만의 제출</span>}</div>
      <h1>{view.board.title}</h1>
      {view.board.description && <p>{view.board.description}</p>}
    </header>
    {error && <Notice>{error}</Notice>}{!view.can_manage && view.principal.role === 'anonymous' && <p className="boards-participation-note"><ShieldCheck size={16} />익명으로 참여 중이에요. 내 글은 오늘 이 브라우저에서 수정할 수 있어요. 함께 쓰는 기기라면 마친 뒤 로그아웃해주세요.</p>}
    {!view.can_manage && view.board.state !== 'open' && <p className="notice">참여가 종료되었어요. 작성한 생각은 계속 확인할 수 있어요.</p>}
    {(view.submission_only || submission) && <p className="boards-participation-note"><LockKeyhole size={16} />내가 작성한 제출만 보여요. 선생님은 전체 답안을 확인할 수 있어요.</p>}

    {view.board.state === 'draft' && view.can_manage && <div className="board-open-strip"><LockKeyhole size={15} /><span>학생 참여가 닫혀 있어요.</span><button className="button ghost" disabled={busy} onClick={() => void changeState()}>참여 열기<ArrowRight size={15} /></button></div>}
    {view.board.format === 'columns' ? <div className="boards-columns">{visibleSections.map(item => <section key={item.id} className={`boards-column${dropTarget === item.id ? ' drop-target' : ''}`} onDragOver={event => { if (dragging) { event.preventDefault(); setDropTarget(item.id); } }} onDrop={event => { event.preventDefault(); drop(item.id); }}><div className="boards-section-heading" {...(draggable ? { draggable: true, title: '끌어서 섹션 순서 바꾸기', onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); setDragging({ kind: 'section', id: item.id }); }, onDragEnd: endDrag } : {})}><h2>{view.can_manage ? <button className="boards-section-rename" onClick={() => openSection({}, item)} title="섹션 이름 수정">{item.title}</button> : item.title}<span>{posts.filter(post => post.section_id === item.id).length}</span></h2>{view.can_manage && <details className="boards-more boards-section-menu"><summary className="button ghost icon-button" aria-label={`${item.title} 섹션 작업`}><MoreHorizontal size={21} /></summary><div onClick={event => { if ((event.target as HTMLElement).closest('button')) event.currentTarget.closest('details')?.removeAttribute('open'); }}><button onClick={() => openSection({}, item)}>섹션 이름 변경</button><button disabled={busy} onClick={() => void moveSection(item.id, 'up')}><ArrowLeft size={16} />왼쪽으로 이동</button><button disabled={busy} onClick={() => void moveSection(item.id, 'down')}><ArrowRight size={16} />오른쪽으로 이동</button><button onClick={() => openSection({ before_id: item.id })}><Plus size={16} />왼쪽에 섹션 추가</button><button onClick={() => openSection({ after_id: item.id })}><Plus size={16} />오른쪽에 섹션 추가</button><button onClick={() => setShare({ type: 'section', target: item.id, title: item.title })}><QrCode size={16} />이 섹션 QR 공유</button><button onClick={() => setPresenting(item.id)}><MonitorPlay size={16} />이 섹션 발표</button><button onClick={() => askRemove(item)}><Trash2 size={16} />섹션 삭제</button></div></details>}</div>{canCompose && <button className="boards-column-add" onClick={() => { setComposeSection(item.id); setEditing(undefined); setCompose(true); }}><Plus size={20} /><span>게시물 추가</span></button>}{posts.filter(post => post.section_id === item.id).map(renderPost)}</section>)}{posts.some(post => !post.section_id) && <section className="boards-column"><h2>미분류</h2>{posts.filter(post => !post.section_id).map(renderPost)}</section>}{view.can_manage && <button className="boards-new-section" onClick={() => openSection()}><Plus size={18} />섹션 추가</button>}</div> : <><div className="boards-section-pills">{visibleSections.map(item => <div key={item.id}><span>{view.can_manage ? <button className="boards-section-rename" onClick={() => openSection({}, item)} title="섹션 이름 수정">{item.title}</button> : item.title}</span>{view.can_manage && <div className="boards-section-actions"><button className="button ghost icon-button" aria-label={`${item.title} 섹션 앞으로 이동`} disabled={busy} onClick={() => void moveSection(item.id, 'up')}><ArrowLeft size={12} /></button><button className="button ghost icon-button" aria-label={`${item.title} 섹션 뒤로 이동`} disabled={busy} onClick={() => void moveSection(item.id, 'down')}><ArrowRight size={12} /></button><button className="button ghost icon-button" aria-label={`${item.title} QR 공유`} onClick={() => setShare({ type: 'section', target: item.id, title: item.title })}><Share2 size={14} /></button><button className="button ghost icon-button" aria-label={`${item.title} 섹션 삭제`} onClick={() => askRemove(item)}><Trash2 size={13} /></button></div>}</div>)}{view.can_manage && <button className="button ghost" onClick={() => openSection()}><Plus size={15} />섹션</button>}</div><div className={`boards-posts boards-posts-${view.board.format}`}>{posts.map(renderPost)}</div></>}
    {!posts.length && (view.board.format !== 'columns' || !visibleSections.length) && <EmptyState title={moderationOnly ? '기다리는 생각이 없어요' : query ? '검색한 생각이 없어요' : '첫 번째 생각을 기다리고 있어요'}>{view.can_manage ? '학생들에게 QR을 공유하거나 먼저 질문을 남겨보세요.' : view.submission_only || submission ? '답안을 제출하면 여기에서 내 제출을 확인할 수 있어요.' : '작은 발견도 좋아요. 여러분의 생각을 남겨주세요.'}</EmptyState>}
    {canCompose && <button className="boards-floating-add button primary" aria-label="새 생각 올리기" onClick={() => { setEditing(undefined); setCompose(true); }}><Plus size={25} /><span>{view.submission_only || submission ? '답안 제출' : '게시'}</span></button>}
    {!!drafts.length && canCompose && !compose && <div className="board-drafts" role="group" aria-label="작성 중인 초안">{drafts.map(draft => <button key={draft.id} className="button secondary" onClick={() => { setEditing(view.posts.find(post => post.id === draft.edit_post_id)); setDraftId(draft.id); setCompose(true); }}><FileText size={15} /><span>{draft.title || '제목 없는 초안'}</span></button>)}</div>}
    {compose && <DraftCompose key={draftId ?? editing?.id ?? 'new'} view={view} post={editing} sectionId={composeSection} draftId={draftId} onClose={closeCompose} onSaved={accept} onMinimize={minimize} />}{activity && <ActivityPanel view={view} onClose={() => setActivity(false)} />}{presenting !== null && <Presentation view={view} initialSectionId={presenting || undefined} onClose={() => setPresenting(null)} />}{settings && <Settings view={view} onClose={() => setSettings(false)} onSaved={accept} />}{share && <ShareDialog boardId={boardId} targetType={share.type} targetId={share.target} title={share.title} onClose={() => setShare(null)} />}
    {participants && <ParticipantsDialog boardId={boardId} onClose={() => setParticipants(false)} />}{addSection && <Dialog title={sectionEditing ? '섹션 이름 수정' : '새 섹션 만들기'} onClose={() => setAddSection(false)}><form className="boards-form" onSubmit={newSection}><label className="field">섹션 이름<input className="input" required value={sectionTitle} maxLength={120} onChange={event => setSectionTitle(event.target.value)} placeholder="예: 모둠별 질문" /></label><p className="muted">섹션은 정리용이며 같은 게시판의 학생들이 함께 볼 수 있어요.</p><button className="button primary" disabled={busy}>{sectionEditing ? '섹션 저장' : '섹션 만들기'}</button></form>{!sectionEditing && !!view.deleted_sections?.length && <div className="boards-deleted-sections"><h3>삭제된 섹션</h3><p className="muted">복원해도 옮겨진 게시물과 회수된 QR은 되돌아가지 않아요.</p><ul>{view.deleted_sections.map(item => <li key={item.id}><span>{item.title}</span><button type="button" className="button ghost" disabled={busy} onClick={() => void restoreSection(item.id)}><RotateCcw size={15} />복원</button></li>)}</ul></div>}</Dialog>}
    {removing && <Dialog title="섹션 삭제" onClose={() => setRemoving(null)}><form className="boards-form" onSubmit={removeSection}><p>“{removing.title}” 섹션을 삭제해요. 이 섹션의 QR 공유는 회수되고, 섹션은 나중에 복원할 수 있어요.</p><label className="field">게시물 {view.posts.filter(post => post.section_id === removing.id).length}개를 옮길 곳<select className="select" value={moveTo} onChange={event => setMoveTo(event.target.value)}><option value="">미분류</option>{view.sections.filter(item => item.id !== removing.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{error && <Notice>{error}</Notice>}<div className="boards-dialog-actions"><button type="button" className="button secondary" onClick={() => setRemoving(null)}>취소</button><button className="button primary" disabled={busy}>섹션 삭제</button></div></form></Dialog>}
  </main>;
}
