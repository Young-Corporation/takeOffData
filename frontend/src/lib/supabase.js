import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  'https://mvkdhylzqcsodigtwrup.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12a2RoeWx6cWNzb2RpZ3R3cnVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjEwNTAsImV4cCI6MjA5MzYzNzA1MH0.5oh_Zk81HwQMITcJpmdicVzjAyEawsurXTHN_kuuN_0'
);
