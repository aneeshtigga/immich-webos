import { useState } from 'preact/hooks';
import { smartSearch } from '../api/client';
import { Asset } from '../api/assets';
import { Thumb } from '../components/Thumb';
import { justify } from '../components/justified';
import { Icon } from '../components/Icon';

// Smart (natural-language) search using Immich's /search/smart endpoint
// ("beach sunset", "dog", "birthday cake"). Results shown as a justified grid.
export function Search({ onOpen }: { onOpen: (assets: Asset[], index: number) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Asset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(e: Event) {
    e.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      setResults(await smartSearch(query.trim()));
    } catch (err: any) {
      setError(err?.message || 'Search failed');
    } finally {
      setBusy(false);
    }
  }

  const width = window.innerWidth - 128;
  const rows = results ? justify(results, width, 170, 6) : [];
  let idx = 0;

  return (
    <div class="search-view">
      <form class="searchbar" onSubmit={run}>
        <Icon name="search" size={26} class="searchbar-icon" />
        <input
          data-focusable
          class="focusable searchbar-input"
          type="search"
          placeholder="Search your photos…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <button data-focusable type="submit" class="focusable searchbar-btn">
          {busy ? '…' : 'Go'}
        </button>
      </form>

      {error && <div class="msg error">{error}</div>}
      {results && !results.length && !busy && (
        <div class="msg">No results for “{query}”.</div>
      )}

      <div class="grid-scroll">
        {rows.map((row, ri) => (
          <div class="jrow" key={ri} style={{ height: `${row.height}px` }}>
            {row.items.map((a) => {
              const myIdx = idx++;
              return (
                <Thumb
                  key={a.id}
                  assetId={a.id}
                  isVideo={a.isVideo}
                  duration={a.duration}
                  width={a.w}
                  height={a.h}
                  onSelect={() => onOpen(results!, myIdx)}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
