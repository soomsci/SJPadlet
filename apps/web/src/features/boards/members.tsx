'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { LogOut, UserPlus, Users, X } from 'lucide-react';
import type { BoardMembers, BoardView, MemberRole } from '@contracts';
import { api, Notice } from '@ui';

const roles: Record<MemberRole, string> = { editor: '편집 가능', reader: '보기 전용' };
const message = (error: unknown) => error instanceof Error ? error.message : '잠시 후 다시 시도해주세요.';

/** Co-teachers of a board: the owner invites/changes/removes; editors see the list and can leave. */
export function MembersPanel({ view }: { view: BoardView }) {
  const path = `/api/boards/${view.board.id}/members`;
  const [data, setData] = useState<BoardMembers | null>(null), [email, setEmail] = useState(''), [role, setRole] = useState<MemberRole>('editor');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { api<BoardMembers>(path).then(setData).catch(error => setError(message(error))); }, [path]);
  const change = async (method: 'POST' | 'DELETE', body: unknown, done?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { setData(await api<BoardMembers>(path, { method, body: JSON.stringify(body) })); if (done) setNotice(done); return true; }
    catch (error) { setError(message(error)); return false; } finally { setBusy(false); }
  };
  const invite = async (event: FormEvent) => { event.preventDefault(); if (await change('POST', { email, role }, '선생님을 추가했어요. 아직 로그인한 적이 없다면 처음 로그인할 때 자동으로 참여해요.')) setEmail(''); };
  const leave = async () => {
    if (!window.confirm('이 게시판에서 나갈까요? 다시 참여하려면 소유 선생님이 초대해야 해요.')) return;
    setBusy(true); setError('');
    try { await api(path, { method: 'DELETE', body: JSON.stringify({ principal_id: view.principal.id }) }); window.location.assign('/dashboard'); }
    catch (error) { setError(message(error)); setBusy(false); }
  };
  const roleSelect = (label: string, value: MemberRole, target: string | null) => <select className="select" aria-label={`${label} 권한`} value={value} disabled={busy || !target} onChange={event => void change('POST', { email: target, role: event.target.value })}>{Object.entries(roles).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select>;
  const edit = data?.can_edit_members;
  return <section className="boards-invite board-members">
    <h3><Users size={18} />함께 수업하는 선생님</h3>
    {data && <ul>
      <li><span><strong>{data.owner.display_name}</strong><small>{data.owner.email}</small></span><span className="badge">소유</span></li>
      {data.members.map(member => <li key={member.principal_id}><span><strong>{member.display_name}</strong><small>{member.email}</small></span>
        {edit ? <span className="board-member-tools">{roleSelect(member.display_name, member.role, member.email)}<button type="button" className="button ghost icon-button" aria-label={`${member.display_name} 선생님 내보내기`} disabled={busy} onClick={() => void change('DELETE', { principal_id: member.principal_id })}><X size={16} /></button></span> : <span className="badge">{roles[member.role]}</span>}</li>)}
      {data.invites.map(item => <li key={item.email}><span><strong>{item.email}</strong><small>첫 로그인 대기 중</small></span>
        {edit ? <span className="board-member-tools">{roleSelect(item.email, item.role, item.email)}<button type="button" className="button ghost icon-button" aria-label={`${item.email} 초대 취소`} disabled={busy} onClick={() => void change('DELETE', { email: item.email })}><X size={16} /></button></span> : <span className="badge">{roles[item.role]}</span>}</li>)}
    </ul>}
    {edit ? <form className="board-member-invite" onSubmit={invite}>
      <label className="field">선생님 학교 이메일<input className="input" type="email" required value={email} placeholder="teacher@samjeong.ms.kr" autoComplete="off" onChange={event => setEmail(event.target.value)} /></label>
      <label className="field">권한<select className="select" value={role} onChange={event => setRole(event.target.value as MemberRole)}>{Object.entries(roles).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <button className="button secondary" disabled={busy || !email}><UserPlus size={16} />추가</button>
    </form> : data && <button type="button" className="button ghost" disabled={busy} onClick={() => void leave()}><LogOut size={16} />이 게시판에서 나가기</button>}
    <p className="muted">편집 가능: 승인·섹션·공유·참여 관리를 함께 해요. 보기 전용: 공개된 글만 봐요. 선생님 초대·해제는 소유 선생님만 할 수 있어요.</p>
    {error && <Notice>{error}</Notice>}{notice && <p role="status">{notice}</p>}
  </section>;
}
