import { Hero } from '../components/Hero';
import { NeedsYou } from '../components/Needs';
import { Today } from '../components/Today';
import { useConsole } from '../state/console';

/**
 * The phone layout. Exactly four things: on air or standing by, what needs you,
 * today's numbers, and Stop all (which the shell pins to the bottom edge).
 */
export function MobileHome() {
  const { snapshot } = useConsole();
  if (!snapshot) return null;
  return (
    <div>
      <h1 className="sr-only">Console</h1>
      <Hero compact />
      <div className="px-4 py-8">
        <NeedsYou large />
      </div>
      <div className="px-4 pb-8">
        <Today today={snapshot.today} compact />
      </div>
    </div>
  );
}
