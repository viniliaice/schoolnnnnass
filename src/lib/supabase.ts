import { createClient } from '@supabase/supabase-js'

// These should be set in environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'your-supabase-url'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-supabase-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
// Test connection
supabase.from('users').select('count').limit(1).then(({ error }) => {
  if (error) {
    console.error('Supabase connection error:', error)
  } else {
    console.log('Supabase connected successfully')
  }
})