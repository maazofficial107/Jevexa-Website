-- Optional Supabase table for Workspace Team Members (worker.js also falls back cleanly to auth user_metadata)
CREATE TABLE IF NOT EXISTS public.team_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('Admin', 'Member', 'Viewer')) DEFAULT 'Member',
    status TEXT NOT NULL CHECK (status IN ('Active', 'Suspended', 'Pending Invite')) DEFAULT 'Pending Invite',
    last_active_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (workspace_user_id, email)
);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace owners manage own team_members" ON public.team_members;
CREATE POLICY "Workspace owners manage own team_members"
    ON public.team_members
    FOR ALL
    USING (auth.uid() = workspace_user_id)
    WITH CHECK (auth.uid() = workspace_user_id);
