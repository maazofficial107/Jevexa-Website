-- ==============================================================================
-- JEVEXA AI STUDIO: MINI CRM & EMAIL OUTREACH AI DATABASE MIGRATION
-- Migration: crm_and_outreach.sql
-- Idempotent script for Supabase SQL Editor
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. TABLE: crm_leads
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    role TEXT,
    website TEXT,
    deal_value NUMERIC DEFAULT 0,
    stage TEXT CHECK (stage IN ('New', 'Contacted', 'Replied', 'Qualified', 'Won', 'Lost')) DEFAULT 'New',
    lead_score INTEGER CHECK (lead_score IS NULL OR (lead_score >= 0 AND lead_score <= 100)) DEFAULT NULL,
    ai_summary TEXT,
    notes TEXT,
    last_contacted_at TIMESTAMPTZ,
    next_followup_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 2. TABLE: crm_activities
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.crm_activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
    type TEXT CHECK (type IN ('note', 'stage_change', 'ai_score', 'email_generated', 'email_sent')),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 3. TABLE: outreach_sequences
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_sequences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES public.crm_leads(id) ON DELETE SET NULL,
    recipient_name TEXT,
    recipient_email TEXT,
    company TEXT,
    goal TEXT,
    tone TEXT,
    initial_subject TEXT,
    initial_body TEXT,
    followup_1_subject TEXT,
    followup_1_body TEXT,
    followup_2_subject TEXT,
    followup_2_body TEXT,
    status TEXT CHECK (status IN ('Draft', 'Opened in Gmail', 'Sent', 'Replied')) DEFAULT 'Draft',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 4. PERFORMANCE INDEXES
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_crm_leads_user_stage ON public.crm_leads (user_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_leads_user_created ON public.crm_leads (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_user_lead ON public.crm_activities (user_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_sequences_user_created ON public.outreach_sequences (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_sequences_lead_id ON public.outreach_sequences (lead_id);

-- ------------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY (RLS) & STRICT USER-ISOLATION POLICIES
-- ------------------------------------------------------------------------------
ALTER TABLE public.crm_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own crm_leads" ON public.crm_leads;
DROP POLICY IF EXISTS "Users can manage own crm_activities" ON public.crm_activities;
DROP POLICY IF EXISTS "Users can manage own outreach_sequences" ON public.outreach_sequences;

CREATE POLICY "Users can manage own crm_leads"
    ON public.crm_leads
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own crm_activities"
    ON public.crm_activities
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage own outreach_sequences"
    ON public.outreach_sequences
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ------------------------------------------------------------------------------
-- 6. AUTOMATIC UPDATED_AT TRIGGER
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_crm_leads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_crm_leads_updated_at ON public.crm_leads;
CREATE TRIGGER trigger_crm_leads_updated_at
    BEFORE UPDATE ON public.crm_leads
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_crm_leads_updated_at();

-- ------------------------------------------------------------------------------
-- 7. SERVICE PRICING REGISTRATION (ZERO-CONFIG GUARANTEE)
-- ------------------------------------------------------------------------------
INSERT INTO public.jevexa_service_pricing (service_key, display_name, integration_status, credits_per_1000_tokens, enabled)
VALUES
    ('mini_crm', 'Mini CRM', 'available', 1, true),
    ('email_outreach', 'Email & Outreach AI', 'available', 1, true)
ON CONFLICT (service_key) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    integration_status = EXCLUDED.integration_status,
    credits_per_1000_tokens = EXCLUDED.credits_per_1000_tokens,
    enabled = EXCLUDED.enabled;

-- ------------------------------------------------------------------------------
-- 8. PERMISSIONS & ROLES
-- ------------------------------------------------------------------------------
GRANT ALL ON public.crm_leads TO authenticated;
GRANT ALL ON public.crm_activities TO authenticated;
GRANT ALL ON public.outreach_sequences TO authenticated;

GRANT ALL ON public.crm_leads TO service_role;
GRANT ALL ON public.crm_activities TO service_role;
GRANT ALL ON public.outreach_sequences TO service_role;
