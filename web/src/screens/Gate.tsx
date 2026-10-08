import { useState } from 'react';
import { api, ApiError, setToken } from '../lib/api';
import { Button, Failure, Lamp } from '../components/ui';

export function Gate({ onToken, expired }: { onToken: (token: string) => void; expired: boolean }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(expired ? 'That token was not accepted. Enter it again.' : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (token === '') return;
    setBusy(true);
    setError(null);
    try {
      await api.snapshot(token);
      setToken(token);
      onToken(token);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That token was not accepted.'
          : err instanceof ApiError && err.status === 0
            ? 'The server could not be reached. Is it running?'
            : 'The server answered with an error. Try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-[34rem] flex-col justify-center px-6 py-12">
      <div className="flex items-center gap-3">
        <Lamp on={false} size="lg" />
        <p className="text-strong font-semibold text-steel-100">ANZ Voice SDR</p>
      </div>
      <h1 className="mt-8 text-statement font-semibold text-steel-100 phone:text-state">Enter the console token</h1>
      <p className="mt-3 max-w-[46ch] text-body text-steel-300">
        This is the ADMIN_TOKEN the server was started with. It stays in this browser tab and is forgotten when you close it.
      </p>
      <form onSubmit={submit} className="mt-8">
        <label htmlFor="token" className="text-label font-semibold text-steel-200">
          Token
        </label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 block min-h-12 w-full rounded-control border border-slate-400 bg-ink-800 px-3 text-strong text-steel-100"
        />
        <div className="mt-4 flex items-center gap-4">
          <Button tone="solid" type="submit" disabled={busy || value.trim() === ''}>
            {busy ? 'Checking…' : 'Open the console'}
          </Button>
        </div>
        {error ? (
          <div className="mt-4">
            <Failure>{error}</Failure>
          </div>
        ) : null}
      </form>
    </main>
  );
}
