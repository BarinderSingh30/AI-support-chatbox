import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '../lib/auth-client.ts';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: signInError } = await authClient.signIn.email({ email, password });
      if (signInError) {
        setError(signInError.message ?? 'Sign-in failed');
        return;
      }
      navigate('/', { replace: true });
    } catch {
      setError('Sign-in failed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-gray-50 font-sans text-sm">
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-8 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-gray-900">Sign in to Groundwork</h1>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-red-700">{error}</p>}
        <div className="space-y-1">
          <label htmlFor="email" className="block font-medium text-gray-700">Email</label>
          <input
            id="email" type="email" required value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-gray-500"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="password" className="block font-medium text-gray-700">Password</label>
          <input
            id="password" type="password" required value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:border-gray-500"
          />
        </div>
        <button
          type="submit" disabled={busy}
          className="w-full rounded-lg bg-gray-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
