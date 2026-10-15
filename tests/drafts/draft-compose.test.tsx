// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BoardView, PostDraft } from '@contracts';
import { api, ApiRequestError } from '@ui';
import { DraftCompose } from '../../apps/web/src/features/boards/draft-compose';
vi.mock('@ui', async importOriginal => { const original = await importOriginal<typeof import('@ui')>(); return { ...original, api: vi.fn() }; });
const mockedApi = vi.mocked(api);
const view: BoardView = { board: { id:'synthetic-board',owner_id:'synthetic-teacher',title:'합성 수업',description:'',format:'columns',state:'open',participation_mode:'both',moderation:false,allow_comments:true,allow_reactions:true,anonymous_display:true,color:'#ffffff',version:1,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',deleted_at:null },sections:[{id:'synthetic-section',board_id:'synthetic-board',title:'합성 모둠',rank:0}],posts:[],can_manage:false,can_write:true,submission_only:false,principal:{id:'synthetic-author',role:'anonymous',display_name:'합성 참여자'} };
const makeDraft = (extra: Partial<PostDraft> = {}): PostDraft => ({id:'00000000-0000-4000-8000-000000000001',board_id:view.board.id,principal_id:view.principal.id,edit_post_id:null,edit_post_version:null,section_id:view.sections[0].id,title:'합성 저장 제목',body:'합성 저장 내용',link:'',color:'#ffffff',attachment_ids:[],version:3,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...extra});
function setup(draftId?: string) { const onClose=vi.fn(),onSaved=vi.fn(),onMinimize=vi.fn();const result=render(<DraftCompose view={view} draftId={draftId} onClose={onClose} onSaved={onSaved} onMinimize={onMinimize}/>);return{...result,onClose,onSaved,onMinimize}; }
beforeEach(()=>{mockedApi.mockReset();mockedApi.mockImplementation(async (path, init) => { if(path==='/api/upload-policy') return {images_only:true,max_bytes:1048576};if(init?.method==='PUT'){const payload=JSON.parse(init.body as string);return makeDraft({...payload,version:payload.version+1,id:path.split('/').at(-1)});}if(init?.method==='POST')return{view};if(init?.method==='DELETE')return{deleted:true};return makeDraft();});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
describe('durable compose drafts',()=>{
 it('shows https:// as a fixed prefix and folds a typed or pasted scheme into it',async()=>{
  const {onMinimize}=setup();await screen.findByText('이미지 첨부 · 자동 압축');
  fireEvent.change(screen.getByRole('textbox',{name:'제목'}),{target:{value:'링크 합성 제목'}});
  const link=screen.getByRole('textbox',{name:'참고 링크'}) as HTMLInputElement;
  fireEvent.change(link,{target:{value:'example.com/a'}});expect(link.value).toBe('example.com/a');
  fireEvent.change(link,{target:{value:' https://https://example.com/b'}});expect(link.value).toBe('example.com/b');
  fireEvent.click(screen.getByRole('button',{name:'최소화'}));
  await waitFor(()=>expect(onMinimize).toHaveBeenCalledOnce());expect(onMinimize.mock.calls[0][0]).toMatchObject({link:'https://example.com/b'});
  fireEvent.change(link,{target:{value:'http://intranet.example/c'}});expect(link.value).toBe('intranet.example/c');expect(link.parentElement!.textContent).toContain('http://');
  fireEvent.change(link,{target:{value:''}});expect(link.parentElement!.textContent).toContain('https://');
 });
 it('saves before minimizing and passes the durable ID and content to the workspace',async()=>{
  const storageWrite=vi.fn();vi.stubGlobal('localStorage',{setItem:storageWrite});
  const {onClose,onMinimize}=setup();await screen.findByText('이미지 첨부 · 자동 압축');fireEvent.change(screen.getByRole('textbox',{name:'제목'}),{target:{value:'최소화 전 합성 제목'}});fireEvent.click(screen.getByRole('button',{name:'최소화'}));
  await waitFor(()=>expect(onMinimize).toHaveBeenCalledOnce());expect(onMinimize.mock.calls[0][0]).toMatchObject({title:'최소화 전 합성 제목',version:1});expect(onClose).not.toHaveBeenCalled();
  expect(storageWrite).not.toHaveBeenCalled();
 });
 it('keeps the dialog and typed content when saving to close fails',async()=>{
  const {onClose}=setup();await screen.findByText('이미지 첨부 · 자동 압축');mockedApi.mockImplementation(async(path)=>{if(path==='/api/upload-policy')return{images_only:true,max_bytes:1048576};throw new Error('합성 저장 실패');});
  fireEvent.change(screen.getByRole('textbox',{name:'내용'}),{target:{value:'보존할 합성 답안'}});fireEvent.click(screen.getByRole('button',{name:'닫기'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent','합성 저장 실패');expect(onClose).not.toHaveBeenCalled();expect((screen.getByRole('textbox',{name:'내용'}) as HTMLTextAreaElement).value).toBe('보존할 합성 답안');
 });
 it('restores a saved server draft and sends its current CAS version',async()=>{
  const draft=makeDraft();const {onClose}=setup(draft.id);expect(await screen.findByDisplayValue('합성 저장 내용')).toBeTruthy();expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'제목'}));fireEvent.change(screen.getByRole('textbox',{name:'내용'}),{target:{value:'다시 편집한 합성 답안'}});fireEvent.click(screen.getByRole('button',{name:'저장하고 닫기'}));
  await waitFor(()=>expect(onClose).toHaveBeenCalledOnce());const call=mockedApi.mock.calls.find(([,init])=>init?.method==='PUT')!;expect(JSON.parse(call[1]!.body as string)).toMatchObject({version:3,body:'다시 편집한 합성 답안'});
 });
 it('saves edits made during an outstanding autosave before it minimizes',async()=>{
  vi.useFakeTimers();let finish!: (draft: PostDraft)=>void;let delayed=true;const original=mockedApi.getMockImplementation()!;mockedApi.mockImplementation(async(path,init)=>{if(init?.method==='PUT'&&delayed){delayed=false;return new Promise<PostDraft>(resolve=>{finish=resolve;});}return original(path,init);});const {onMinimize}=setup();await act(async()=>{});fireEvent.change(screen.getByRole('textbox',{name:'제목'}),{target:{value:'자동 저장 중 합성 제목'}});await act(async()=>{await vi.advanceTimersByTimeAsync(1200);});fireEvent.change(screen.getByRole('textbox',{name:'내용'}),{target:{value:'저장 기다리며 추가한 합성 답안'}});fireEvent.click(screen.getByRole('button',{name:'최소화'}));await act(async()=>{finish(makeDraft({title:'자동 저장 중 합성 제목',body:'',version:1}));});expect(onMinimize).toHaveBeenCalledOnce();expect(onMinimize.mock.calls[0][0]).toMatchObject({body:'저장 기다리며 추가한 합성 답안',version:2});const puts=mockedApi.mock.calls.filter(([,init])=>init?.method==='PUT');expect(puts).toHaveLength(2);expect(JSON.parse(puts[1][1]!.body as string).version).toBe(1);
 });
 it('stops autosave after a conflict and preserves unsaved text',async()=>{
  vi.useFakeTimers();const {onMinimize}=setup();await act(async()=>{});mockedApi.mockImplementation(async()=>{throw new ApiRequestError('합성 충돌',409);});fireEvent.change(screen.getByRole('textbox',{name:'내용'}),{target:{value:'충돌 중 보존 답안'}});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1200);});expect(screen.getByRole('alert').textContent).toBe('합성 충돌');const calls=mockedApi.mock.calls.length;fireEvent.change(screen.getByRole('textbox',{name:'내용'}),{target:{value:'추가로 입력한 답안'}});await act(async()=>{await vi.advanceTimersByTimeAsync(2400);});expect(mockedApi.mock.calls.length).toBe(calls);fireEvent.click(screen.getByRole('button',{name:'최소화'}));await act(async()=>{});expect(onMinimize).not.toHaveBeenCalled();expect((screen.getByRole('textbox',{name:'내용'}) as HTMLTextAreaElement).value).toBe('추가로 입력한 답안');
 });
 it('publishes without a prior draft request and keeps the text as a server draft when posting fails',async()=>{
  const {onClose,onSaved}=setup();await screen.findByText('이미지 첨부 · 자동 압축');const previous=mockedApi.getMockImplementation()!;mockedApi.mockImplementation(async(path,init)=>{if(init?.method==='POST')throw new Error('합성 게시 실패');return previous(path,init);});fireEvent.change(screen.getByRole('textbox',{name:'제목'}),{target:{value:'게시 전 합성 제목'}});fireEvent.submit(screen.getByRole('textbox',{name:'제목'}).closest('form')!);
  await screen.findByText('합성 게시 실패');const methods=mockedApi.mock.calls.map(([,init])=>init?.method).filter(Boolean);expect(methods).toEqual(['POST','PUT']);const posted=mockedApi.mock.calls.find(([,init])=>init?.method==='POST')!;const body=JSON.parse(posted[1]!.body as string);expect(body).toMatchObject({title:'게시 전 합성 제목'});expect(body).not.toHaveProperty('draft_version');expect(onSaved).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled();expect(screen.getByText('초안 저장됨 · 14일 보관')).toBeTruthy();
 });
 it('retries a lost creation response with the same content and retry key',async()=>{
  const {onSaved}=setup();await screen.findByText('이미지 첨부 · 자동 압축');const original=mockedApi.getMockImplementation()!;let tries=0;mockedApi.mockImplementation(async(path,init)=>{if(init?.method==='POST'){if(tries++===0)throw new TypeError('합성 네트워크 실패');return{view};}return original(path,init);});fireEvent.change(screen.getByRole('textbox',{name:'제목'}),{target:{value:'재시도 합성 제목'}});const form=screen.getByRole('textbox',{name:'제목'}).closest('form')!;fireEvent.submit(form);await screen.findByText('합성 네트워크 실패');fireEvent.submit(form);await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());const puts=mockedApi.mock.calls.filter(([,init])=>init?.method==='PUT'),posts=mockedApi.mock.calls.filter(([,init])=>init?.method==='POST');expect(puts).toHaveLength(1);expect(posts).toHaveLength(2);const [first,second]=posts.map(([,init])=>init!);expect(second.headers).toEqual(first.headers);
  // Same content and retry key; the retry also consumes the draft saved after the first attempt failed.
  const {draft_id,draft_version,...retried}=JSON.parse(second.body as string);expect(retried).toEqual(JSON.parse(first.body as string));expect(draft_version).toBe(1);expect(draft_id).toBeTruthy();
 });
 it('preserves a deleted section until the author explicitly chooses a replacement',async()=>{
  const original=mockedApi.getMockImplementation()!;mockedApi.mockImplementation(async(path,init)=>{if(path!=='/api/upload-policy'&&!init?.method)return makeDraft({section_id:'removed-section'});return original(path,init);});setup(makeDraft().id);await screen.findByDisplayValue('합성 저장 내용');expect(screen.getByText(/이 초안의 섹션이 삭제/)).toBeTruthy();expect((screen.getByRole('combobox',{name:'섹션'}) as HTMLSelectElement).value).toBe('removed-section');expect(mockedApi.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);fireEvent.change(screen.getByRole('combobox',{name:'섹션'}),{target:{value:'synthetic-section'}});expect(screen.queryByText(/이 초안의 섹션이 삭제/)).toBeNull();
 });
});
