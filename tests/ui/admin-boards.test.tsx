// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SchoolBoardsPanel } from '@features/admin/school-boards';
import type { AdminBoard } from '@contracts';
const { apiMock }=vi.hoisted(()=>({apiMock:vi.fn()}));
vi.mock('@ui',async importOriginal=>({...await importOriginal<object>(),api:apiMock}));
const board:AdminBoard={id:'synthetic-board',owner_id:'teacher',title:'합성 과학 수업',state:'open',format:'wall',version:7,deleted_at:null,updated_at:'2026-11-05T00:00:00.000Z',owner_name:'합성 교사',owner_email:'teacher@example.invalid',owner_disabled_at:null,post_count:4,pending_count:2};
const teachers=[{id:'teacher',display_name:'합성 교사',email:'teacher@example.invalid',disabled_at:null},{id:'next',display_name:'다음 교사',email:'next@example.invalid',disabled_at:null},{id:'disabled',display_name:'정지 교사',email:'disabled@example.invalid',disabled_at:'2026-10-15'}];
const changed=vi.fn(async()=>{});
function renderPanel(){return render(<SchoolBoardsPanel teachers={teachers} onChange={changed}/>);}
async function manage(){fireEvent.click(await screen.findByRole('button',{name:board.title+' 관리'}));return screen.getByRole('dialog',{name:'게시판 관리'});}
beforeEach(()=>{changed.mockClear();apiMock.mockReset();apiMock.mockImplementation(async(path:string)=>path.startsWith('/api/admin/boards?')?{boards:[board],next_cursor:null}:{});});
afterEach(cleanup);
describe('school-wide board controls',()=>{
  it('shows owner/counts and searches by text, lifecycle and owner',async()=>{
    renderPanel();await screen.findByText(board.title);expect(screen.getByText('게시글 4 · 승인 대기 2')).toBeTruthy();expect(screen.getByRole('link',{name:board.title+' 게시판 열기'}).getAttribute('href')).toBe('/boards/'+board.id);
    fireEvent.change(screen.getByRole('searchbox',{name:'게시판·선생님 검색'}),{target:{value:'모둠'}});
    fireEvent.change(screen.getByRole('combobox',{name:'게시판 상태'}),{target:{value:'trash'}});
    fireEvent.change(screen.getByRole('combobox',{name:'소유 교사'}),{target:{value:'next'}});fireEvent.click(screen.getByRole('button',{name:'검색'}));
    await waitFor(()=>expect(apiMock).toHaveBeenLastCalledWith('/api/admin/boards?'+new URLSearchParams({q:'모둠',state:'trash',owner:'next'})));
  });
  it('requires explicit confirmation for trash and sends the displayed version only once',async()=>{
    renderPanel();const dialog=within(await manage());fireEvent.change(dialog.getByRole('combobox',{name:'관리 작업'}),{target:{value:'trash'}});
    const submit=dialog.getByRole('button',{name:'휴지통으로 이동'});expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(dialog.getByRole('checkbox'));fireEvent.click(submit);
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/boards/'+board.id,{method:'DELETE',body:JSON.stringify({version:7})}));
    await screen.findByRole('status');expect(changed).toHaveBeenCalledTimes(1);expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('transfers to a different active teacher selected by name instead of a board ID',async()=>{
    renderPanel();const dialog=within(await manage());fireEvent.change(dialog.getByRole('combobox',{name:'관리 작업'}),{target:{value:'transfer'}});
    const owner=dialog.getByRole('combobox',{name:'새 소유 교사'});
    expect(within(owner).queryByRole('option',{name:/정지 교사/})).toBeNull();expect(within(owner).queryByRole('option',{name:/합성 교사/})).toBeNull();
    fireEvent.change(owner,{target:{value:'next'}});fireEvent.click(dialog.getByRole('checkbox'));fireEvent.click(dialog.getByRole('button',{name:'소유권 이전'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/admin/transfer',{method:'POST',body:JSON.stringify({board_id:board.id,owner_id:'next',version:7})}));
  });
  it('restores trash as closed, hides its open link, and offers only restore',async()=>{
    apiMock.mockResolvedValue({boards:[{...board,deleted_at:'2026-11-04'}],next_cursor:null});renderPanel();const dialog=within(await manage());
    expect(screen.queryByRole('link',{name:board.title+' 게시판 열기'})).toBeNull();
    expect(dialog.getAllByRole('option').map(option=>option.textContent)).toEqual(['작업을 선택해주세요','복원하기']);
    fireEvent.change(dialog.getByRole('combobox',{name:'관리 작업'}),{target:{value:'restore'}});expect(dialog.getByText(/참여가 종료된 상태로 복원/)).toBeTruthy();fireEvent.click(dialog.getByRole('button',{name:'복원하기'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/boards/'+board.id+'/restore',{method:'POST',body:JSON.stringify({version:7})}));
  });
  it('shows stale-write errors in the dialog and reloads before trying again',async()=>{
    apiMock.mockImplementation(async(path:string,init?:RequestInit)=>init?.method==='PATCH'?Promise.reject(new Error('다른 변경이 있습니다.')):{boards:[board],next_cursor:null});
    renderPanel();const dialog=within(await manage());fireEvent.change(dialog.getByRole('combobox',{name:'관리 작업'}),{target:{value:'closed'}});fireEvent.click(dialog.getByRole('button',{name:'참여 종료'}));
    await screen.findByRole('alert');expect(screen.getByText('다른 변경이 있습니다.')).toBeTruthy();expect(changed).not.toHaveBeenCalled();
    apiMock.mockResolvedValue({boards:[{...board,version:8}],next_cursor:null});fireEvent.click(screen.getByRole('button',{name:'최신 목록 불러오기'}));
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());const refreshed=within(await manage());fireEvent.change(refreshed.getByRole('combobox',{name:'관리 작업'}),{target:{value:'closed'}});fireEvent.click(refreshed.getByRole('button',{name:'참여 종료'}));
    await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/boards/'+board.id,{method:'PATCH',body:JSON.stringify({state:'closed',version:8})}));
  });
  it('recovers from a failed list load and renders the empty state',async()=>{
    apiMock.mockRejectedValue(new Error('연결을 확인해주세요.'));renderPanel();await screen.findByRole('alert');expect(screen.queryByRole('list')).toBeNull();
    apiMock.mockResolvedValue({boards:[],next_cursor:null});fireEvent.click(screen.getByRole('button',{name:'목록 새로고침'}));expect(await screen.findByText('해당하는 게시판이 없습니다')).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
  });
  it('traps keyboard focus and returns it to the manage button on Escape',async()=>{
    renderPanel();const button=await screen.findByRole('button',{name:board.title+' 관리'});button.focus();fireEvent.click(button);
    const dialog=screen.getByRole('dialog');const first=within(dialog).getByRole('button',{name:'닫기'}),last=within(dialog).getByRole('button',{name:'취소'});
    first.focus();fireEvent.keyDown(document,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(button);
  });
  it('discards late responses from an earlier filter request',async()=>{
    let resolveFirst!:(value:unknown)=>void;
    apiMock.mockImplementationOnce(()=>new Promise(resolve=>{resolveFirst=resolve;})).mockResolvedValue({boards:[],next_cursor:null});
    renderPanel();fireEvent.change(screen.getByRole('searchbox'),{target:{value:'없는 결과'}});fireEvent.click(screen.getByRole('button',{name:'검색'}));
    await screen.findByText('해당하는 게시판이 없습니다');await act(async()=>{resolveFirst({boards:[board],next_cursor:null});});expect(screen.queryByText(board.title)).toBeNull();
  });
});
