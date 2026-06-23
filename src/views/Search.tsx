import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import { isBack } from '../nav/keys';
import {
  smartSearch,
  getPeople,
  getPlaces,
  searchByPerson,
  searchByCity,
  Person,
  Place,
} from '../api/client';
import { Asset } from '../api/assets';
import { loadThumb, loadPersonThumb } from '../api/media';
import { Thumb } from '../components/Thumb';
import { justify, targetRowHeight, GRID_GAP } from '../components/justified';
import { Icon } from '../components/Icon';

// Escape a string for safe use inside a CSS attribute selector. Place values
// (city names) can contain spaces, quotes, or diacritics. Falls back to a
// manual escape on the older webOS Chromium where CSS.escape may be absent.
function cssEscape(s: string): string {
  const fn = (window as any).CSS?.escape;
  if (typeof fn === 'function') return fn(s);
  return s.replace(/["\\\]]/g, '\\$&');
}

// Search page mirroring Immich web: a text (smart) search box, plus browsable
// People (named face circles) and Places (cities) when no search is active.
// Selecting a person or place runs a metadata search and shows the results in
// the shared justified grid; clearing returns to the browse view.
export function Search({ onOpen }: { onOpen: (assets: Asset[], index: number) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Asset[] | null>(null);
  const [resultLabel, setResultLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [people, setPeople] = useState<Person[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // browse-key of the last opened chip/card, so returning from its results
  // restores focus to it instead of resetting to the first item.
  const lastOpenedRef = useRef<string | null>(null);

  // Load the browse facets once. Failures are non-fatal (e.g. ML disabled on
  // the server) — the section just stays empty.
  useEffect(() => {
    getPeople().then(setPeople).catch(() => {});
    getPlaces().then(setPlaces).catch(() => {});
  }, []);

  // `originKey` (optional) is the browse-key of the chip/card that triggered
  // this search, remembered so Back can restore focus to it.
  async function runWith(label: string, fn: () => Promise<Asset[]>, originKey?: string) {
    if (busy) return;
    lastOpenedRef.current = originKey ?? null;
    setBusy(true);
    setError('');
    setResultLabel(label);
    try {
      setResults(await fn());
    } catch (err: any) {
      setError(err?.message || 'Search failed');
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  const submit = () => {
    const q = query.trim();
    if (!q) return;
    runWith(q, () => smartSearch(q));
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    submit();
  };

  // Keys inside the text field. The global remote handler would otherwise turn
  // Enter into a no-op click and left/right into spatial navigation (jumping to
  // people below). In the field, arrows should move the text caret, not nav —
  // except Right at the end of the text, which steps to the clear (X) button if
  // it's shown. stopPropagation keeps these from reaching the window handler.
  const onInputKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLInputElement;
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }
    const atEnd = el.selectionStart === el.value.length && el.selectionStart === el.selectionEnd;
    // Right at text end with the X visible → let global nav move focus to X.
    if ((e.key === 'ArrowRight' || e.keyCode === 39) && atEnd && query) return;
    // All other left/right: keep focus in the field (caret move only).
    if (
      e.key === 'ArrowLeft' || e.keyCode === 37 ||
      e.key === 'ArrowRight' || e.keyCode === 39
    ) {
      e.stopPropagation();
    }
  };

  const clearResults = () => {
    setResults(null);
    setResultLabel('');
    setError('');
  };

  // Back from a results view returns to the browse view (People/Places), not
  // out of Search entirely. Capture phase + stopPropagation so this runs before
  // Home's window-level onBack (which would otherwise open the sidebar). Only
  // active while results are shown; otherwise Back falls through to Home.
  useEffect(() => {
    if (results === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBack(e.keyCode)) return;
      // If the fullscreen viewer is open over the results (opened a photo from
      // them), let Back close the viewer first — its own handler runs on the
      // bubble phase, after this capture-phase one, so bail without consuming
      // the event. Only collapse the results once the viewer is gone.
      if (document.querySelector('.fs')) return;
      e.preventDefault();
      e.stopPropagation();
      clearResults();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [results]);

  const browsing = results === null && !busy;

  // When returning to the browse view, restore focus to the chip/card that was
  // opened (matched by data-browse-key) instead of leaving focus reset.
  useLayoutEffect(() => {
    if (!browsing) return;
    const key = lastOpenedRef.current;
    if (!key) return;
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-browse-key="${cssEscape(key)}"]`,
    );
    if (el) el.focus();
    lastOpenedRef.current = null;
  }, [browsing]);

  // When results load, move focus to the first photo so the d-pad lands in the
  // grid instead of on the now-hidden chip. (Thumb fetches its image lazily,
  // but the button itself is in the DOM immediately.)
  useLayoutEffect(() => {
    if (!results || !results.length) return;
    rootRef.current?.querySelector<HTMLElement>('.grid-scroll .thumb')?.focus();
  }, [results]);

  const width = window.innerWidth - 128;
  const rows = results ? justify(results, width, targetRowHeight(), GRID_GAP) : [];
  let idx = 0;

  return (
    <div class="search-view" ref={rootRef}>
      <form class="searchbar" onSubmit={onSubmit}>
        <Icon name="search" size={26} class="searchbar-icon" />
        <input
          ref={inputRef}
          data-focusable
          data-wide
          class="focusable searchbar-input"
          type="text"
          placeholder="Search your photos…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={onInputKey}
        />
        {query && (
          <button
            data-focusable
            type="button"
            class="focusable searchbar-clear"
            title="Clear search text"
            onClick={() => {
              // clear only the text field; leave any results visible. The X
              // unmounts once the query is empty, so move focus back to the
              // input explicitly.
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={24} />
          </button>
        )}
      </form>

      {error && <div class="msg error">{error}</div>}

      {browsing ? (
        <div class="search-browse">
          {people.length > 0 && (
            <section class="browse-section">
              <h2 class="browse-title">People</h2>
              <div class="people-row">
                {people.map((p) => (
                  <PersonChip
                    key={p.id}
                    person={p}
                    browseKey={'person:' + p.id}
                    onSelect={() =>
                      runWith(p.name, () => searchByPerson(p.id), 'person:' + p.id)
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {places.length > 0 && (
            <section class="browse-section">
              <h2 class="browse-title">Places</h2>
              <div class="places-grid">
                {places.map((pl) => (
                  <PlaceCard
                    key={pl.value}
                    place={pl}
                    browseKey={'place:' + pl.value}
                    onSelect={() =>
                      runWith(pl.value, () => searchByCity(pl.value), 'place:' + pl.value)
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {!people.length && !places.length && (
            <div class="msg">Type above to search your photos.</div>
          )}
        </div>
      ) : (
        <>
          {resultLabel && (
            <div class="result-head">
              <button
                data-focusable
                class="focusable result-back"
                onClick={clearResults}
              >
                <Icon name="back" size={24} />
                <span>Search</span>
              </button>
              <h2 class="result-title">{resultLabel}</h2>
            </div>
          )}
          {results && !results.length && !busy && (
            <div class="msg">No results for “{resultLabel}”.</div>
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
        </>
      )}
    </div>
  );
}

function PersonChip({
  person,
  browseKey,
  onSelect,
}: {
  person: Person;
  browseKey: string;
  onSelect: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadPersonThumb(person.id)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [person.id]);

  return (
    <button
      data-focusable
      data-browse-key={browseKey}
      class="focusable person-chip"
      onClick={onSelect}
      title={person.name}
    >
      <div class="person-face">
        {src ? <img class="person-img fade-img" src={src} /> : <div class="thumb-ph" />}
      </div>
      <div class="person-name">{person.name}</div>
    </button>
  );
}

function PlaceCard({
  place,
  browseKey,
  onSelect,
}: {
  place: Place;
  browseKey: string;
  onSelect: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadThumb(place.assetId)
      .then((u) => alive && setSrc(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [place.assetId]);

  return (
    <button
      data-focusable
      data-browse-key={browseKey}
      class="focusable place-card"
      onClick={onSelect}
      title={place.value}
    >
      <div class="place-cover">
        {src ? <img class="place-img fade-img" src={src} /> : <div class="thumb-ph" />}
        <div class="place-label">{place.value}</div>
      </div>
    </button>
  );
}
