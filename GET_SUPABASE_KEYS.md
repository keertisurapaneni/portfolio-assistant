# How to Get Your Supabase Anon Key

## The Problem:

The key `sb_publishable_kcEPjHepMOE-3BXy3Kd6WA_Dx1jNUNg` is NOT a valid Supabase anon key.

Supabase anon keys are JWT tokens that:

- Start with `eyJ...`
- Are 300+ characters long
- Look like: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1amxo...`

## Where to Find the REAL Anon Key:

### Method 1: Supabase Dashboard (EASIEST)

1. Go directly to: https://app.supabase.com/project/qujlhamichlfrldeemti/settings/api
2. Scroll down to **Project API keys** section
3. Look for the key labeled **anon** or **anon public**
4. Click the 👁️ (eye) icon to reveal the full key
5. Click the 📋 (copy) icon to copy it

The section should look like:

```
Project API keys
────────────────
anon
public
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  [👁️] [📋]
```

### Method 2: Check another page

If you don't see it there, try:

1. Go to: https://app.supabase.com/project/qujlhamichlfrldeemti/settings/general
2. Look for "API URL" or "Configuration" section
3. The anon key should be visible

## Common Confusion:

- ❌ `sb_publishable_...` = This is NOT the anon key
- ✅ `eyJhbGciOi...` = This IS the anon key (JWT format, very long)

## Update Your .env File:

Once you find the correct key (starts with `eyJ` and is very long), update `/app/.env`:

```bash
# Current (WRONG):
VITE_SUPABASE_ANON_KEY=sb_publishable_kcEPjHepMOE-3BXy3Kd6WA_Dx1jNUNg

# Should be (CORRECT - paste full JWT):
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF1amxo...
```

The anon key should be 300-500 characters long!

**IMPORTANT:** The anon key is safe to expose in client-side code. It's protected by Row Level Security (RLS) policies.
