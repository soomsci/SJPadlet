'use client';
import { useEffect,useEffectEvent,useRef,useState } from 'react';
import { ArrowLeft,ArrowRight,ExternalLink,Maximize,Minimize,Presentation as PresentationIcon,X } from 'lucide-react';
import type { BoardView } from '@contracts';
import './presentation.css';

export function Presentation({view,initialSectionId,onClose}:{view:BoardView;initialSectionId?:string;onClose:()=>void}){
 const element=useRef<HTMLDivElement>(null);
 const [sectionId,setSectionId]=useState(initialSectionId??'');
 const selectedSection=view.sections.some(section=>section.id===sectionId)?sectionId:'';
 // The API has already filtered reads. Never broaden that set or fetch another board view here.
 const posts=view.posts.filter(post=>post.status==='published'&&(!selectedSection||post.section_id===selectedSection));
 const [postId,setPostId]=useState(()=>posts[0]?.id??'');
 const selectedIndex=posts.findIndex(post=>post.id===postId);
 const index=selectedIndex<0?0:selectedIndex,post=posts[index];
 const [fullscreen,setFullscreen]=useState(false),[notice,setNotice]=useState('');
 const closeFromKeyboard=useEffectEvent(onClose);
 const navigateFromKeyboard=useEffectEvent((key:string)=>{
  if(!posts.length)return;
  const next=key==='Home'?0:key==='End'?posts.length-1:Math.max(0,Math.min(posts.length-1,index+(key==='ArrowRight'?1:-1)));
  setPostId(posts[next].id);
 });
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,dialog=element.current;
  dialog?.focus();
  const onKey=(event:KeyboardEvent)=>{
   if(!dialog?.contains(event.target as Node)||event.isComposing||event.keyCode===229)return;
   if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeFromKeyboard();return;}
   if(event.key==='Tab'){
    const controls=Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select:not([disabled]),[tabindex="0"]'));
    const first=controls[0],last=controls.at(-1);
    if((event.shiftKey&&(document.activeElement===first||document.activeElement===dialog))||(!event.shiftKey&&document.activeElement===last)){
     event.preventDefault();event.stopImmediatePropagation();(event.shiftKey?last:first)?.focus();
    }
    return;
   }
   const target=event.target as HTMLElement;
   if(target.matches('input,textarea,select')||target.isContentEditable)return;
   if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();navigateFromKeyboard(event.key);}
  };
  const fullscreenChanged=()=>setFullscreen(document.fullscreenElement===dialog);
  document.addEventListener('keydown',onKey,true);document.addEventListener('fullscreenchange',fullscreenChanged);
  return()=>{
   document.removeEventListener('keydown',onKey,true);document.removeEventListener('fullscreenchange',fullscreenChanged);
   if(dialog&&document.fullscreenElement===dialog&&document.exitFullscreen)void document.exitFullscreen().catch(()=>undefined);
   if(previous?.isConnected)previous.focus();
  };
 },[]);
 async function toggleFullscreen(){
  setNotice('');
  try{
   if(document.fullscreenElement===element.current){if(document.exitFullscreen)await document.exitFullscreen();return;}
   if(!element.current?.requestFullscreen)throw new Error('Unsupported fullscreen');
   await element.current.requestFullscreen();
  }catch{setNotice('전체 화면을 사용할 수 없어 현재 화면에서 발표를 계속합니다.');}
 }
 function move(direction:number){const next=posts[index+direction];if(next)setPostId(next.id);}
 return <div className="board-presentation" role="dialog" aria-modal="true" aria-label="게시판 발표" ref={element} tabIndex={-1}>
  <header className="board-presentation-toolbar"><div className="board-presentation-heading"><PresentationIcon size={19}/><span>{view.board.title}</span></div><div className="board-presentation-actions">
   <label className="board-presentation-section">발표 범위<select value={selectedSection} onChange={event=>{setSectionId(event.target.value);setPostId('');}}><option value="">게시판 전체</option>{view.sections.map(section=><option value={section.id} key={section.id}>{section.title}</option>)}</select></label>
   <button type="button" onClick={()=>void toggleFullscreen()} aria-label={fullscreen?'전체 화면 종료':'전체 화면'} title={fullscreen?'전체 화면 종료':'전체 화면'}>{fullscreen?<Minimize size={21}/>:<Maximize size={21}/>}</button>
   <button type="button" onClick={onClose} aria-label="발표 닫기"><X size={23}/></button>
  </div></header>
  {notice&&<p className="board-presentation-notice" role="status">{notice}</p>}
  <main className="board-presentation-stage">
   {post?<article className="board-presentation-slide" key={post.id} style={{backgroundColor:post.color}} aria-label="발표 슬라이드">
    <p className="board-presentation-author">{post.author_name}</p><h2>{post.title}</h2>{post.body&&<p className="board-presentation-body">{post.body}</p>}
    {!!post.attachments.filter(file=>file.status==='ready'&&file.mime.startsWith('image/')).length&&<div className="board-presentation-images">{post.attachments.filter(file=>file.status==='ready'&&file.mime.startsWith('image/')).map(file=><img key={file.id} src={`/api/attachments/${encodeURIComponent(file.id)}/content`} alt={file.name}/>)}</div>}
    {post.link&&/^https?:\/\//.test(post.link)&&<a className="board-presentation-link" href={post.link} target="_blank" rel="noopener noreferrer"><ExternalLink size={18}/><span>{post.link}</span></a>}
   </article>:<div className="board-presentation-empty"><PresentationIcon size={48}/><h2>발표할 공개 글이 없어요</h2><p>승인 대기·반려·숨긴 글과 초안은 발표에 표시되지 않습니다.</p></div>}
  </main>
  <footer className="board-presentation-navigation"><button type="button" onClick={()=>move(-1)} disabled={!post||index===0} aria-label="이전 슬라이드"><ArrowLeft size={23}/></button><p role="status" aria-live="polite">{post?index+1:0} / {posts.length}</p><button type="button" onClick={()=>move(1)} disabled={!post||index===posts.length-1} aria-label="다음 슬라이드"><ArrowRight size={23}/></button><span>← → 이동 · Home 처음 · End 마지막 · Esc 닫기</span></footer>
 </div>;
}
