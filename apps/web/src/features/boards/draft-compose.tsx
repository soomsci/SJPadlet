'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Camera, FileText, Minimize2, Paperclip, ShieldCheck, X } from 'lucide-react';
import type { Attachment, BoardView, PostDraft, PostView } from '@contracts';
import { api, ApiRequestError, Notice, Spinner } from '@ui';
import { compressClassroomImage } from '@features/uploads';
import { Dialog } from './dialog';
import './draft-compose.css';

type Content = Pick<PostDraft, 'title' | 'body' | 'link' | 'section_id' | 'color' | 'attachment_ids' | 'edit_post_id' | 'edit_post_version'>;
export interface DraftComposeProps { view: BoardView; post?: PostView; sectionId?: string; draftId?: string; onClose: () => void; onSaved: (view: BoardView) => void; onMinimize: (draft: PostDraft) => void; }
const message = (error: unknown) => error instanceof Error ? error.message : '잠시 후 다시 시도해주세요.';
export function DraftCompose({ view, post, sectionId, draftId, onClose, onSaved, onMinimize }: DraftComposeProps) {
  const initial: Content = { title: post?.title ?? '', body: post?.body ?? '', link: post?.link ?? '', section_id: post?.section_id ?? sectionId ?? view.sections[0]?.id ?? null, color: post?.color ?? '#ffffff', attachment_ids: post?.attachments.map(file => file.id) ?? [], edit_post_id: post?.id ?? null, edit_post_version: post?.version ?? null };
  const [content, setContent] = useState(initial), [loading, setLoading] = useState(!!draftId), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [savedAt, setSavedAt] = useState('');
  const [files, setFiles] = useState<PostView['attachments']>(post?.attachments ?? []);
  const [policy, setPolicy] = useState<{ images_only: boolean; max_bytes: number } | null>(null);
  const [identity] = useState(() => draftId ?? crypto.randomUUID()), [requestKey] = useState(() => crypto.randomUUID());
  const titleInput = useRef<HTMLInputElement>(null), restoreFocused = useRef(false);
  const attemptedPost = useRef<{ serialized: string; payload: Content & { draft_id: string; draft_version: number } } | null>(null);
  const latest = useRef(content), persisted = useRef(JSON.stringify(initial)), version = useRef(0), pending = useRef<Promise<PostDraft> | null>(null), conflict = useRef(false), draft = useRef<PostDraft | null>(null), alive = useRef(true);
  latest.current = content;
  const draftPath = `/api/boards/${view.board.id}/drafts/${identity}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { api<{ images_only: boolean; max_bytes: number }>('/api/upload-policy').then(result => { if (alive.current) setPolicy(result); }).catch(() => { if (alive.current) setError('첨부 설정을 불러오지 못했습니다. 다시 열어주세요.'); }); }, []);
  useEffect(() => {
    if (!draftId) return;
    let active = true;
    api<PostDraft>(draftPath).then(result => {
      if (!active) return;
      const restored: Content = { title: result.title, body: result.body, link: result.link, section_id: result.section_id, color: result.color, attachment_ids: result.attachment_ids, edit_post_id: result.edit_post_id, edit_post_version: result.edit_post_version };
      draft.current = result; version.current = result.version; persisted.current = JSON.stringify(restored); latest.current = restored; setContent(restored);
      const known = view.posts.flatMap(item => item.attachments);
      setFiles(result.attachment_ids.map((id, index) => known.find(file => file.id === id) ?? { id, name: `저장된 첨부 ${index + 1}`, mime: 'image/jpeg', bytes: 0, status: 'ready' }));
      setSavedAt(result.updated_at); setLoading(false);
    }).catch(error => { if (active) { setError(message(error)); conflict.current = true; } });
    return () => { active = false; };
    // A background board refresh must not replace unsaved fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, draftPath]);
  useEffect(() => { if (draftId && !loading && !restoreFocused.current) { restoreFocused.current = true; titleInput.current?.focus(); } }, [draftId, loading]);
  const save = useCallback(async (force = false): Promise<PostDraft | null> => {
    while (pending.current) await pending.current;
    if (loading) throw new Error('초안을 불러오는 중입니다.');
    if (conflict.current) throw new Error('초안이 다른 창에서 변경되었거나 접근 권한이 바뀌었습니다. 현재 내용을 복사한 뒤 초안을 다시 열어주세요.');
    const snapshot = { ...latest.current }, serialized = JSON.stringify(snapshot);
    if (!force && serialized === persisted.current) return draft.current;
    setSaving(true);
    const request = api<PostDraft>(draftPath, { method: 'PUT', body: JSON.stringify({ ...snapshot, version: version.current }) });
    pending.current = request;
    try {
      const result = await request; draft.current = result; version.current = result.version; persisted.current = serialized;
      if (alive.current) { setSavedAt(result.updated_at); setError(''); }
      return result;
    } catch (error) {
      if (error instanceof ApiRequestError && [401, 403, 404, 409].includes(error.status)) conflict.current = true;
      if (alive.current) setError(message(error));
      throw error;
    } finally { pending.current = null; if (alive.current) setSaving(false); }
  }, [draftPath, loading]);
  useEffect(() => {
    if (loading || busy || uploading || conflict.current || JSON.stringify(content) === persisted.current) return;
    const timer = setTimeout(() => { void save().catch(() => {}); }, 1200);
    return () => clearTimeout(timer);
  }, [content, loading, busy, uploading, save]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (pending.current || JSON.stringify(latest.current) !== persisted.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const sectionMissing = !!content.section_id && !view.sections.some(item => item.id === content.section_id);
  const update = (change: Partial<Content>) => setContent(current => ({ ...current, ...change }));
  const leave = async (minimize: boolean) => {
    if (busy || uploading || loading) return;
    setBusy(true);
    try { const result = await save(minimize && !draft.current); if (minimize && result) onMinimize(result); else onClose(); }
    catch (error) { setError(message(error)); } finally { if (alive.current) setBusy(false); }
  };
  const upload = async (picked: FileList | null) => {
    if (!picked?.length || !policy) return;
    if (latest.current.attachment_ids.length + picked.length > 5) { setError('파일은 글 하나에 5개까지 첨부할 수 있어요.'); return; }
    setUploading(true); setError('');
    try {
      for (const original of Array.from(picked)) {
        const file = policy.images_only ? await compressClassroomImage(original) : original;
        const form = new FormData(); form.append('file', file);
        const uploaded = await api<Attachment>(`/api/boards/${view.board.id}/attachments`, { method: 'POST', body: form });
        setFiles(current => [...current, uploaded]); setContent(current => ({ ...current, attachment_ids: [...current.attachment_ids, uploaded.id] }));
      }
    } catch (error) { setError(message(error)); } finally { setUploading(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || uploading || loading) return; setBusy(true); setError('');
    try {
      const serialized = JSON.stringify(latest.current);
      const retry = attemptedPost.current?.serialized === serialized ? attemptedPost.current : null;
      const saved = retry ? null : await save(true);
      if (!retry && !saved) throw new Error('초안을 저장하지 못했습니다.');
      const target = latest.current.edit_post_id ? view.posts.find(item => item.id === latest.current.edit_post_id) : undefined;
      if (latest.current.edit_post_id && !target) throw new Error('편집할 글을 찾을 수 없습니다. 입력은 초안에 보관됩니다.');
      const data = retry?.payload ?? { ...latest.current, ...(target ? { version: latest.current.edit_post_version ?? target.version } : {}), draft_id: identity, draft_version: saved!.version };
      if (!target) attemptedPost.current = { serialized, payload: data };
      if (target) onSaved(await api<BoardView>(`/api/posts/${target.id}`, { method: 'PATCH', body: JSON.stringify(data) }));
      else { const result = await api<{ view: BoardView }>(`/api/boards/${view.board.id}/posts`, { method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify(data) }); onSaved(result.view); }
      persisted.current = JSON.stringify(latest.current); onClose();
    } catch (error) { if (error instanceof ApiRequestError && error.status < 500) attemptedPost.current = null; setError(message(error)); } finally { if (alive.current) setBusy(false); }
  };
  const discard = async () => {
    if (busy || uploading || !window.confirm('작성 중인 초안을 삭제할까요? 이 내용은 복원할 수 없습니다.')) return;
    setBusy(true);
    try { if (pending.current) await pending.current; if (draft.current) await api(draftPath, { method: 'DELETE', body: JSON.stringify({ version: version.current }) }); persisted.current = JSON.stringify(latest.current); onClose(); }
    catch (error) { setError(message(error)); } finally { if (alive.current) setBusy(false); }
  };
  return <Dialog title={content.edit_post_id ? '생각 수정하기' : view.submission_only ? '내 답안 제출하기' : '새로운 생각 남기기'} onClose={() => { if (loading && error) onClose(); else void leave(false); }} variant="compose">
    {loading ? <>{!error && <Spinner />}{error && <Notice>{error}</Notice>}</> : <form className="boards-form" onSubmit={submit}>
      <div className="draft-status"><span role="status">{saving ? '초안 저장 중…' : savedAt ? '초안 저장됨 · 14일 보관' : '입력하면 자동으로 초안이 저장됩니다'}</span><button type="button" className="button ghost" disabled={busy || uploading} onClick={() => void leave(true)}><Minimize2 size={16} />최소화</button></div>
      {view.board.moderation && !view.can_manage && <p className="boards-help"><ShieldCheck size={16} />선생님 확인 후 공개됩니다. 수정하면 다시 승인을 받아요.</p>}
      <label className="field board-compose-title">제목<input ref={titleInput} className="input" autoComplete="off" required maxLength={200} disabled={busy || !view.can_write} value={content.title} onChange={event => update({ title: event.target.value })} placeholder="어떤 생각을 발견했나요?" /></label>
      <label className="field board-compose-body">내용<textarea className="textarea" rows={6} maxLength={10000} disabled={busy || !view.can_write} value={content.body} onChange={event => update({ body: event.target.value })} placeholder="생각, 질문, 발견을 자유롭게 적어주세요." /></label>
      {sectionMissing && <Notice>이 초안의 섹션이 삭제되었습니다. 내용은 유지됩니다. 새 섹션을 선택해주세요.</Notice>}
      <div className="boards-form-row"><label className="field">섹션<select className="select" value={content.section_id ?? ''} disabled={busy || !view.can_write || (!!sectionId && !view.can_manage && !sectionMissing)} onChange={event => update({ section_id: event.target.value || null })}>{sectionMissing && <option value={content.section_id!}>삭제된 섹션 · 위치 선택 필요</option>}<option value="">미분류</option>{view.sections.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="field">참고 링크<input className="input" type="url" disabled={busy || !view.can_write} value={content.link} onChange={event => update({ link: event.target.value })} placeholder="https://" /></label></div>
      <label className="field">카드 색<input type="color" disabled={busy || !view.can_write} value={content.color} onChange={event => update({ color: event.target.value })} /></label>
      <label className="boards-upload"><Paperclip size={18} />{uploading ? '업로드 중…' : policy?.images_only ? '이미지 첨부 · 자동 압축' : '파일 첨부'}<input type="file" multiple accept={policy?.images_only ? 'image/jpeg,image/png,image/webp' : undefined} aria-label="첨부 파일 선택" disabled={!policy || !view.can_write || busy || uploading || files.length >= 5} onChange={event => { void upload(event.target.files); event.target.value = ''; }} /><small>{policy ? `파일당 최대 ${policy.max_bytes / 1024 ** 2}MB · 5개까지` : '설정 확인 중…'}</small></label>
      <label className="boards-upload draft-camera"><Camera size={18} />사진 찍기<input type="file" accept="image/*" capture="environment" aria-label="카메라로 사진 찍기" disabled={!policy || !view.can_write || busy || uploading || files.length >= 5} onChange={event => { void upload(event.target.files); event.target.value = ''; }} /></label>
      {policy?.images_only && <p className="muted">문서와 동영상은 참고 링크로 공유해주세요.</p>}
      {!!files.length && <ul className="boards-attachments">{files.map(file => <li key={file.id}>{file.mime.startsWith('image/') ? <img className="draft-thumb" src={`/api/attachments/${encodeURIComponent(file.id)}/content`} alt="" /> : <FileText size={16} />}<span>{file.name}</span><button type="button" disabled={busy || !view.can_write} className="button ghost icon-button" aria-label={`${file.name} 첨부 취소`} onClick={() => { setFiles(current => current.filter(item => item.id !== file.id)); update({ attachment_ids: latest.current.attachment_ids.filter(id => id !== file.id) }); }}><X size={15} /></button></li>)}</ul>}
      {error && <Notice>{error}</Notice>}
      <div className="boards-dialog-actions draft-compose-actions"><button type="button" className="button ghost" disabled={busy || uploading} onClick={() => void discard()}>초안 삭제</button><button type="button" className="button secondary" disabled={busy || uploading} onClick={() => void leave(false)}>저장하고 닫기</button><button className="button primary" disabled={busy || uploading || !view.can_write}>{busy ? '저장 중…' : content.edit_post_id ? '수정 저장' : '생각 올리기'}<ArrowRight size={17} /></button></div>
    </form>}
  </Dialog>;
}
