import { z } from 'zod';
export type Role = 'admin' | 'teacher' | 'student' | 'anonymous';
export interface Principal { id:string; role:Role; display_name:string; email:string|null; disabled_at:string|null; provider_subject:string|null; created_at:string; }
export type BoardFormat = 'wall'|'grid'|'columns';
export type BoardState = 'draft'|'open'|'closed'|'archived';
export interface Board { id:string; owner_id:string; title:string; description:string; format:BoardFormat; state:BoardState; participation_mode:'both'|'login'; moderation:boolean; allow_comments:boolean; allow_reactions:boolean; anonymous_display:boolean; color:string; column_width?:number; font_scale?:'small'|'normal'|'large'; card_density?:'comfortable'|'compact'; background_style?:'solid'|'gradient'|'paper'; version:number; deleted_at:string|null; created_at:string; updated_at:string; }
export interface Section { id:string; board_id:string; title:string; rank:number; deleted_at?:string|null; }
export type PostStatus = 'pending'|'published'|'rejected'|'hidden'|'deleted';
export interface Post { id:string; board_id:string; section_id:string|null; author_id:string; title:string; body:string; link:string|null; status:PostStatus; color:string; rank:number; version:number; created_at:string; updated_at:string; }
export interface Comment { id:string; post_id:string; author_id:string; body:string; created_at:string; }
export interface Attachment {id:string;board_id:string;post_id:string|null;uploader_id:string;name:string;mime:string;bytes:number;storage_key:string;status:'quarantined'|'ready'|'rejected';created_at:string;}
export interface Share {id:string;board_id:string;target_type:'board'|'post'|'section'|'submission';target_id:string;scope:'read'|'write';token_hash:string;code_hash:string;expires_at:string;revoked_at:string|null;version:number;created_at:string;}
export interface Participation {id:string;principal_id:string;board_id:string;share_id:string;share_version:number;blocked_at:string|null;created_at:string;}
export interface PostView extends Omit<Post,'author_id'> { author_name:string; is_mine:boolean; can_edit:boolean; likes:number; liked:boolean; comments: {id:string;body:string;author_name:string;is_mine:boolean;created_at:string}[]; attachments:{id:string;name:string;mime:string;bytes:number;status:Attachment['status']}[]; }
export interface BoardView {board:Board;sections:Section[];deleted_sections?:Section[];posts:PostView[];can_manage:boolean;can_write:boolean;submission_only:boolean;principal:Pick<Principal,'id'|'role'|'display_name'>;}
export interface PostDraft {id:string;board_id:string;principal_id:string;edit_post_id:string|null;edit_post_version:number|null;section_id:string|null;title:string;body:string;link:string;color:string;attachment_ids:string[];version:number;created_at:string;updated_at:string;}
export interface TeacherAdmission {email:string;enabled:boolean;created_by:string;created_at:string;}
export interface OperationRun {id:string;kind:'backup'|'cleanup'|'restore';status:'running'|'completed'|'failed';storage_key:string|null;bytes:number;message:string;created_at:string;completed_at:string|null;}
export interface ShareResult {id:string;url:string;code:string;expires_at:string;target_type:Share['target_type'];target_id:string;}
export const boardInput = z.object({title:z.string().trim().min(1).max(200),description:z.string().max(5000).default(''),format:z.enum(['wall','grid','columns']).default('wall'),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#e9eee7'),participation_mode:z.enum(['both','login']).default('both'),moderation:z.boolean().default(false),anonymous_display:z.boolean().default(true)});
export const postInput=z.object({title:z.string().trim().min(1).max(200),body:z.string().max(10000).default(''),section_id:z.string().nullable().optional(),link:z.union([z.url().refine(v=>/^https?:\/\//.test(v)),z.literal('')]).optional(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),attachment_ids:z.array(z.string()).max(5).default([]),draft_id:z.uuid().optional(),draft_version:z.number().int().positive().optional()}).refine(v=>Boolean(v.draft_id)===(v.draft_version!==undefined),'초안과 버전을 함께 전달해주세요.');
export const shareInput=z.object({board_id:z.string(),target_type:z.enum(['board','post','section','submission']),target_id:z.string(),scope:z.enum(['read','write']).default('write'),expires_hours:z.number().int().min(1).max(720).default(24)});
export type ApiResult<T>={data:T;meta?:Record<string,unknown>};
