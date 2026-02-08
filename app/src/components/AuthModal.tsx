import { useState } from 'react';
import { X, Loader2, Mail, Lock } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ErrorBanner } from './ErrorBanner';

interface AuthModalProps { onClose: () => void }

export function AuthModal({ onClose }: AuthModalProps) {
  const { signUp, signIn } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError('Please fill in all fields'); return; }
    if (mode === 'signup') {
      if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    }
    setLoading(true);
    try {
      const result = mode === 'signup'
        ? await signUp(email.trim(), password)
        : await signIn(email.trim(), password);
      if (result.error) setError(result.error);
      else onClose();
    } catch { setError('Connection error. Please try again.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in-up">
        <div className="flex items-center justify-between px-6 pt-6 pb-2">
          <h2 className="text-xl font-bold text-[hsl(var(--foreground))]">
            {mode === 'login' ? 'Log In' : 'Create Account'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[hsl(var(--secondary))] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
          <div>
            <label htmlFor="auth-email" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[hsl(var(--muted-foreground))]" />
              <input id="auth-email" name="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" disabled={loading} autoFocus
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]" />
            </div>
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[hsl(var(--muted-foreground))]" />
              <input id="auth-password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'Min 8 characters' : 'Your password'} disabled={loading}
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]" />
            </div>
          </div>

          {mode === 'signup' && (
            <div>
              <label htmlFor="auth-confirm" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-1">Confirm Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[hsl(var(--muted-foreground))]" />
                <input id="auth-confirm" name="confirm-password" type="password" autoComplete="new-password"
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password" disabled={loading}
                  className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]" />
              </div>
            </div>
          )}

          {error && <ErrorBanner message={error} />}

          <button type="submit" disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold hover:from-blue-700 hover:to-indigo-700 shadow-md shadow-blue-500/25 disabled:opacity-60 transition-all">
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" />{mode === 'login' ? 'Logging in...' : 'Creating account...'}</>
              : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>

          <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
            {mode === 'login' ? (
              <>Don't have an account?{' '}<button type="button" onClick={() => { setMode('signup'); setError(null); }} className="text-blue-600 font-medium hover:underline">Sign up</button></>
            ) : (
              <>Already have an account?{' '}<button type="button" onClick={() => { setMode('login'); setError(null); }} className="text-blue-600 font-medium hover:underline">Log in</button></>
            )}
          </p>
        </form>
      </div>
    </div>
  );
}
