// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../supabase',()=>({supabase:{auth:{getSession:async()=>({data:{session:{access_token:'admin-jwt'}}})}}}));
import { FingerprintAttendance } from '../../pages/admin/FingerprintAttendance';

afterEach(()=>{vi.unstubAllGlobals();document.body.innerHTML='';});
it('does not request an import on page open and one click sends one request',async()=>{
 const fetchMock=vi.fn().mockResolvedValue({ok:true,json:async()=>({jobId:'job-1',message:'queued'})});vi.stubGlobal('fetch',fetchMock);
 const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);
 await act(async()=>{root.render(<FingerprintAttendance/>);});expect(fetchMock).not.toHaveBeenCalled();
 const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('Download Fingerprint Records'))!;expect(button).toBeTruthy();
 await act(async()=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][0]).toBe('/api/fingerprint-attendance/import');
 await act(async()=>root.unmount());
});
