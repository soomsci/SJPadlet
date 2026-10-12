// @vitest-environment jsdom
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { AdminPage } from '@features/admin';
const { apiMock }=vi.hoisted(()=>({apiMock:vi.fn()}));
vi.mock('@features/operations',()=>({OperationsPanel:()=>null}));
vi.mock('@ui',async importOriginal=>({...await importOriginal<object>(),api:apiMock}));
beforeEach(()=>{apiMock.mockReset();apiMock.mockImplementation(async(path:string,options?:RequestInit)=>{
 if(path==='/api/admin/summary')return {boards:0,teachers:1,posts:0,bytes:'0'};
 if(path==='/api/admin/admissions'&&!options)return [{email:'allowed@samjeong.ms.kr',enabled:true,created_by:'test-admin',created_at:'2026-10-12T00:00:00.000Z'}];
 if(path==='/api/admin/admissions'&&options?.method==='PUT')return JSON.parse(options.body as string);
 return [];
});});
afterEach(cleanup);
describe('school teacher admission controls',()=>{
 it('lets an administrator register a teacher without a prior account',async()=>{
  render(<AdminPage/>);const input=await screen.findByRole('textbox',{name:'학교 이메일'});
  fireEvent.change(input,{target:{value:'new@samjeong.ms.kr'}});fireEvent.click(screen.getByRole('button',{name:'교사 등록'}));
  await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/admin/admissions',{method:'PUT',body:JSON.stringify({email:'new@samjeong.ms.kr',enabled:true})}));
  await screen.findByText('교사 허용 명단에 등록했습니다. 해당 선생님은 Google로 다시 로그인해주세요.');expect((input as HTMLInputElement).value).toBe('');
 });
 it('shows revocation clearly and sends an explicit false admission',async()=>{
  render(<AdminPage/>);fireEvent.click(await screen.findByRole('button',{name:'허용 해제'}));
  await waitFor(()=>expect(apiMock).toHaveBeenCalledWith('/api/admin/admissions',{method:'PUT',body:JSON.stringify({email:'allowed@samjeong.ms.kr',enabled:false})}));
  await screen.findByText('교사 권한과 기존 로그인 세션을 해제했습니다.');
 });
 it('preserves the entered email and displays a server rejection when saving fails',async()=>{
  const implementation=apiMock.getMockImplementation()!;apiMock.mockImplementation((path:string,options?:RequestInit)=>options?.method==='PUT'?Promise.reject(new Error('학교 이메일을 입력해주세요.')):implementation(path,options));
  render(<AdminPage/>);const input=await screen.findByRole('textbox',{name:'학교 이메일'});fireEvent.change(input,{target:{value:'outside@example.invalid'}});fireEvent.click(screen.getByRole('button',{name:'교사 등록'}));
  await screen.findByText('학교 이메일을 입력해주세요.');expect((input as HTMLInputElement).value).toBe('outside@example.invalid');expect(screen.getByRole('button',{name:'교사 등록'}).hasAttribute('disabled')).toBe(false);
 });
});
