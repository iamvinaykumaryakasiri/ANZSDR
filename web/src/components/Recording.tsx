import { useEffect, useRef, useState } from 'react';
import { api, ApiError, loadRecording } from '../lib/api';
import { clock } from '../lib/time';
import { Button } from './ui';

type Phase = 'idle' | 'loading' | 'ready' | 'none' | 'error';

/**
 * Plays a call's recording from a given second. The recording sits behind the
 * token, so it is fetched with the Authorization header and played from an
 * object URL. `url` skips the lookup when the caller already has it.
 */
export function RecordingPlayer({
  callId,
  url,
  startAt = 0,
  label,
  autoPlay = true
}: {
  callId: string;
  url?: string | null;
  startAt?: number;
  label?: string;
  autoPlay?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [src, setSrc] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current?.startsWith('blob:')) URL.revokeObjectURL(objectUrl.current);
    },
    []
  );

  const start = Math.max(0, startAt);

  const load = async () => {
    setPhase('loading');
    try {
      const recordingUrl = url !== undefined ? url : (await api.call(callId)).recordingUrl;
      if (!recordingUrl) {
        setPhase('none');
        return;
      }
      const playable = await loadRecording(recordingUrl);
      objectUrl.current = playable;
      setSrc(playable);
      setPhase('ready');
    } catch (e) {
      setMessage(e instanceof ApiError && e.status !== 0 ? e.message : 'The recording could not be loaded.');
      setPhase('error');
    }
  };

  if (phase === 'none') return <p className="text-label text-steel-300">No recording was kept for this call.</p>;
  if (phase === 'error')
    return (
      <p className="text-label font-bold text-steel-100">
        {message}{' '}
        <button type="button" onClick={() => void load()} className="underline underline-offset-4">
          Try again
        </button>
      </p>
    );
  if (phase === 'ready' && src)
    return (
      <audio
        ref={audio}
        src={src}
        controls
        preload="auto"
        aria-label={`Recording, starting at ${clock(start)}`}
        className="h-10 w-full max-w-sm"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (start > 0 && Number.isFinite(el.duration)) el.currentTime = Math.min(start, Math.max(0, el.duration - 0.25));
          if (autoPlay) void el.play().catch(() => undefined);
        }}
      />
    );
  return (
    <Button className="min-h-10 px-3 py-1 text-label" disabled={phase === 'loading'} onClick={() => void load()}>
      {phase === 'loading' ? 'Loading…' : (label ?? `Play from ${clock(start)}`)}
    </Button>
  );
}
