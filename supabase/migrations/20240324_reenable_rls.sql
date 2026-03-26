-- Re-enable RLS with proper policies after auth is working
-- Run this AFTER confirming login works with RLS disabled

-- First, create a function to safely check admin status
CREATE OR REPLACE FUNCTION is_admin_user()
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  user_role TEXT;
BEGIN
  -- Get the role directly without triggering RLS
  SELECT role INTO user_role
  FROM users
  WHERE id = auth.uid();

  RETURN user_role = 'admin';
END;
$$;

-- Re-enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Create proper role-based policies

-- Allow users to read their own profile
CREATE POLICY "Users can read own profile" ON users
  FOR SELECT USING (auth.uid() = id);

-- Allow users to update their own profile
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Allow admins to do everything (using the safe function)
CREATE POLICY "Admins have full access" ON users
  FOR ALL USING (is_admin_user());

-- Allow service role full access
CREATE POLICY "Service role has full access" ON users
  FOR ALL USING (auth.role() = 'service_role');