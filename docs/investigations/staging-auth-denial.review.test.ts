// Supplemental investigation only. Mocked clients; no account creation/network.
// Does not alter application code or the six baseline assertions.
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase',()=>({supabase:{rpc:vi.fn(),auth:{signUp:vi.fn(),getSession:vi.fn(),setSession:vi.fn()}},createAuthedClient:vi.fn()}));
vi.mock('../../src/lib/auth',()=>({getProfileByAuthId:vi.fn()}));
import { supabase, createAuthedClient } from '../../src/lib/supabase';
import { getProfileByAuthId } from '../../src/lib/auth';
import { createUser } from '../../src/lib/db/profiles';
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(supabase.auth.getSession).mockResolvedValue({data:{session:{access_token:'synthetic-token',user:{id:'synthetic-auth'}}},error:null} as never);
});
it.each([null,{id:'synthetic-office',role:'office'}])('denies staff creation with invalid profile %j before any side effect',async(profile)=>{
 vi.mocked(getProfileByAuthId).mockResolvedValue(profile as never);
 await expect(createUser({name:'Synthetic staff',email:'synthetic@example.invalid',role:'office',password:'synthetic-test-only'} as never)).rejects.toThrow('Only administrators can create staff accounts. Office users may create parent accounts.');
 expect(supabase.auth.signUp).not.toHaveBeenCalled();
 expect(supabase.auth.setSession).not.toHaveBeenCalled();
 expect(createAuthedClient).not.toHaveBeenCalled();
 expect(supabase.rpc).not.toHaveBeenCalled();
});
