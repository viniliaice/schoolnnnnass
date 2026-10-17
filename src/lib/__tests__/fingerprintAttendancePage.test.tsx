// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../supabase',()=>({supabase:{auth:{getSession:async()=>({data:{session:{access_token:'admin-jwt'}}})}}}));
import { FingerprintAttendance } from '../../pages/admin/FingerprintAttendance';

afterEach(()=>{vi.unstubAllGlobals();document.body.innerHTML='';});
it('does not request an import on page open and one click sends one request',async()=>{
 const fetchMock=vi.fn().mockImplementation((url:string)=>Promise.resolve(url.endsWith('/credential')?{ok:true,status:200,text:async()=>JSON.stringify({configured:false})}:{ok:true,status:202,text:async()=>JSON.stringify({jobId:'job-1',message:'queued'})}));vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 await act(async()=>{root.render(<FingerprintAttendance/>);});expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][0]).toBe('/api/fingerprint-attendance/credential');
 const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('Download Fingerprint Records'))!;expect(button).toBeTruthy();
 await act(async()=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(fetchMock).toHaveBeenCalledTimes(2);expect(fetchMock.mock.calls[1][0]).toBe('/api/fingerprint-attendance/import');
 await act(async()=>root.unmount());
});
it('shows a useful API diagnostic instead of a JSON parse exception for an empty response',async()=>{
 const fetchMock=vi.fn().mockImplementation((url:string)=>Promise.resolve(url.endsWith('/credential')?{ok:true,status:200,text:async()=>JSON.stringify({configured:false})}:{ok:false,status:500,text:async()=>''}));vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 await act(async()=>{root.render(<FingerprintAttendance/>);});
 const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('Download Fingerprint Records'))!;
 await act(async()=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('empty response (HTTP 500)');
 await act(async()=>root.unmount());
});
