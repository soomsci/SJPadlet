'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Search, Settings2 } from 'lucide-react';
import type { AdminBoard, AdminBoardList, BoardState } from '@contracts';
import { api, EmptyState, Notice, Spinner } from '@ui';
import { Dialog } from '../boards/dialog';
import './school-boards.css';

type Teacher = { id:string; display_name:string; email:string|null; disabled_at:string|null };
const states: Record<BoardState,string> = { draft:'준비 중', open:'참여 중', closed:'참여 종료', archived:'보관됨' };
const labels = { open:'참여 열기', closed:'참여 종료', archived:'보관하기', trash:'휴지통으로 이동', restore:'복원하기', transfer:'소유권 이전' };
type Action = keyof typeof labels;
const transitions: Record<BoardState,Action[]> = { draft:['open'], open:['closed'], closed:['open','archived'], archived:['open','closed'] };
const stateLabel = (board:AdminBoard) => board.deleted_at ? '휴지통' : states[board.state];

export function SchoolBoardsPanel({ teachers, onChange }: { teachers:Teacher[]; onChange:()=>Promise<void> }) {
  const [q,setQ] = useState(''), [state,setState] = useState('all'), [owner,setOwner] = useState('');
  const [filters,setFilters] = useState({q:'',state:'all',owner:''});
  const [data,setData] = useState<AdminBoardList|null>(null), [loading,setLoading] = useState(true);
  const [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [selected,setSelected] = useState<AdminBoard|null>(null), [action,setAction] = useState<Action|''>(''), [newOwner,setNewOwner] = useState(''), [confirmed,setConfirmed] = useState(false), [busy,setBusy] = useState(false);
  const requestId = useRef(0), saving = useRef(false);
  const load = useCallback(async(cursor?:string) => {
    const request = ++requestId.current;
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams(filters);
      if(cursor) query.set('cursor',cursor);
      const result = await api<AdminBoardList>('/api/admin/boards?'+query);
      if(request===requestId.current) setData(previous=>cursor&&previous ? {...result,boards:[...new Map([...previous.boards,...result.boards].map(board=>[board.id,board])).values()]} : result);
    } catch(e) { if(request===requestId.current){setError((e as Error).message);setData(null);} }
    finally { if(request===requestId.current) setLoading(false); }
  },[filters]);
  const cancelPending = useCallback(()=>{requestId.current++;},[]);
  useEffect(()=>{void load();return cancelPending;},[load,cancelPending]);
  function choose(board:AdminBoard){setSelected(board);setAction('');setNewOwner('');setConfirmed(false);setError('');setNotice('');}
  function close(){if(!saving.current)setSelected(null);}
  async function submit(event:FormEvent){
    event.preventDefault();
    if(!selected||!action||saving.current||((action==='trash'||action==='transfer')&&!confirmed))return;
    saving.current=true;setBusy(true);setError('');setNotice('');
    try {
      const base = '/api/boards/'+encodeURIComponent(selected.id);
      if(action==='transfer')await api('/api/admin/transfer',{method:'POST',body:JSON.stringify({board_id:selected.id,owner_id:newOwner,version:selected.version})});
      else if(action==='trash')await api(base,{method:'DELETE',body:JSON.stringify({version:selected.version})});
      else if(action==='restore')await api(base+'/restore',{method:'POST',body:JSON.stringify({version:selected.version})});
      else await api(base,{method:'PATCH',body:JSON.stringify({state:action,version:selected.version})});
      setSelected(null);setNotice(`“${selected.title}” ${labels[action]} 작업을 완료했습니다.`);
      await Promise.all([load(),onChange()]);
    } catch(e) {setError((e as Error).message);}
    finally {saving.current=false;setBusy(false);}
  }
  return <section className="card admin-section school-boards" aria-labelledby="school-boards-title">
    <div className="school-boards-heading"><div><h2 id="school-boards-title">전체 게시판</h2><p>학교의 모든 게시판을 관리합니다. 다른 교사의 게시판 열람과 관리 작업은 운영 기록에 남습니다.</p></div><button className="button secondary" disabled={loading||busy} onClick={()=>void load()}>목록 새로고침</button></div>
    <form className="school-boards-filters" onSubmit={event=>{event.preventDefault();setFilters({q:q.trim(),state,owner});setNotice('');}}>
      <label className="field">게시판·선생님 검색<input className="input" type="search" maxLength={200} value={q} onChange={e=>setQ(e.target.value)} placeholder="게시판 이름, 교사 이름 또는 이메일"/></label>
      <label className="field">게시판 상태<select className="select" value={state} onChange={e=>setState(e.target.value)}><option value="all">전체 (휴지통 제외)</option>{Object.entries(states).map(([value,label])=><option key={value} value={value}>{label}</option>)}<option value="trash">휴지통</option></select></label>
      <label className="field">소유 교사<select className="select" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">모든 선생님</option>{teachers.map(t=><option key={t.id} value={t.id}>{t.display_name} · {t.email}{t.disabled_at?' (정지)':''}</option>)}</select></label>
      <button className="button primary" disabled={busy}><Search size={16} aria-hidden="true"/>검색</button>
    </form>
    {error&&!selected&&<Notice>{error}</Notice>}{notice&&<p className="school-boards-notice" role="status">{notice}</p>}
    {loading&&!data?<Spinner/>:data&&<>
      <p className="school-boards-count" aria-live="polite">게시판 {data.boards.length}개 표시{data.next_cursor?' · 아래에서 더 불러올 수 있습니다.':''}{loading?' · 불러오는 중…':''}</p>
      {!data.boards.length?<EmptyState title="해당하는 게시판이 없습니다">검색어나 상태, 소유 교사를 바꾸어 찾아보세요.</EmptyState>:<ul className="school-boards-list" aria-label="학교 전체 게시판">{data.boards.map(board=><li key={board.id}>
        <div className="school-boards-name"><strong>{board.title}</strong><span>{stateLabel(board)} · {board.format==='columns'?'열':board.format==='grid'?'격자':'벽'}</span></div>
        <div className="school-boards-owner"><span>{board.owner_name}{board.owner_disabled_at?' (정지)':''}</span><small>{board.owner_email}</small></div>
        <div className="school-boards-meta"><span>게시글 {board.post_count} · 승인 대기 {board.pending_count}</span><small>최근 수정 {new Date(board.updated_at).toLocaleDateString('ko-KR')}</small></div>
        <div className="school-boards-actions">{!board.deleted_at&&<a className="button secondary" href={'/boards/'+encodeURIComponent(board.id)} aria-label={`${board.title} 게시판 열기`}><ExternalLink size={15} aria-hidden="true"/>열기</a>}<button className="button secondary" disabled={busy||loading} onClick={()=>choose(board)} aria-label={`${board.title} 관리`}><Settings2 size={15} aria-hidden="true"/>관리</button></div>
      </li>)}</ul>}
      {data.next_cursor&&<button className="button secondary school-boards-more" disabled={loading} onClick={()=>void load(data.next_cursor!)}>더 불러오기</button>}
    </>}
    {selected&&<Dialog title="게시판 관리" onClose={close}><div className="school-boards-dialog">
      <h3>{selected.title}</h3><p>{selected.owner_name} · {stateLabel(selected)}</p>
      <form onSubmit={event=>void submit(event)}>
        <label className="field">관리 작업<select className="select" required disabled={busy} value={action} onChange={e=>{setAction(e.target.value as Action|'');setConfirmed(false);}}><option value="">작업을 선택해주세요</option>{(selected.deleted_at?['restore'] as Action[]:[...transitions[selected.state],'trash','transfer'] as Action[]).map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>
        {action==='transfer'&&<label className="field">새 소유 교사<select className="select" required disabled={busy} value={newOwner} onChange={e=>setNewOwner(e.target.value)}><option value="">선생님을 선택해주세요</option>{teachers.filter(t=>!t.disabled_at&&t.id!==selected.owner_id).map(t=><option value={t.id} key={t.id}>{t.display_name} · {t.email}</option>)}</select></label>}
        {action==='trash'&&<p>학생과 교사의 접근이 중단됩니다. 휴지통에서 복원할 수 있으며, 30일이 지나면 자동 정리 대상이 됩니다.</p>}
        {action==='restore'&&<p>참여가 종료된 상태로 복원합니다. 학생 참여를 허용하려면 복원 후 참여를 열어주세요.</p>}
        {action==='archived'&&<p>학생 접근을 막고 보관합니다. 필요할 때 다시 참여를 열 수 있습니다.</p>}
        {action==='transfer'&&<p>새 소유 교사가 게시판을 관리하게 됩니다. 기존 소유 교사는 별도의 공동 교사 권한이 없으면 접근할 수 없습니다.</p>}
        {(action==='trash'||action==='transfer')&&<label className="school-boards-confirm"><input type="checkbox" required checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>이 게시판에 적용할 작업을 확인했습니다.</label>}
        {error&&<><Notice>{error}</Notice><button type="button" className="button secondary" disabled={busy} onClick={()=>{setSelected(null);void load();}}>최신 목록 불러오기</button></>}
        <div className="school-boards-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>취소</button><button className={`button ${action==='trash'?'danger':'primary'}`} disabled={busy||!action||((action==='trash'||action==='transfer')&&!confirmed)||(action==='transfer'&&!newOwner)}>{busy?'처리 중…':action?labels[action]:'작업 적용'}</button></div>
      </form>
    </div></Dialog>}
  </section>;
}
