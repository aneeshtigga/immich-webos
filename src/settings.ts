// Small persisted UI preferences. webOS web apps have a normal localStorage
// that survives app restarts (same store the auth state uses).

const LIVE_PLAY_KEY = 'immich.livePlay';
const VIDEO_QUALITY_KEY = 'immich.videoQuality';
const SORT_KEY = 'immich.sort.';

export type VideoQuality = 'transcoded' | 'original';

// Preferred video stream quality. Defaults to transcoded (lighter for the TV);
// once the user switches a video to Original it becomes the default for every
// video and sticks across restarts.
export function getVideoQuality(): VideoQuality {
  return localStorage.getItem(VIDEO_QUALITY_KEY) === 'original' ? 'original' : 'transcoded';
}

export function setVideoQuality(q: VideoQuality): void {
  if (q === 'original') localStorage.setItem(VIDEO_QUALITY_KEY, 'original');
  else localStorage.removeItem(VIDEO_QUALITY_KEY);
}

// Whether Live Photos autoplay their motion clip. Off by default; the user
// turns it on with OK/Enter on a Live Photo and it sticks across restarts.
export function getLivePlay(): boolean {
  return localStorage.getItem(LIVE_PLAY_KEY) === '1';
}

export function setLivePlay(on: boolean): void {
  if (on) localStorage.setItem(LIVE_PLAY_KEY, '1');
  else localStorage.removeItem(LIVE_PLAY_KEY);
}

// Per-section sort direction. 'desc' (newest first) is the default everywhere;
// the user flips a section to 'asc' (oldest first) from its header sort button
// and it sticks across restarts. Each browsable section stores independently so
// e.g. albums can read oldest-first while the main timeline stays newest-first.
export type SortDir = 'asc' | 'desc';
export type SortSection = 'timeline' | 'favorites' | 'albums' | 'album';

export function getSort(section: SortSection): SortDir {
  return localStorage.getItem(SORT_KEY + section) === 'asc' ? 'asc' : 'desc';
}

export function setSort(section: SortSection, dir: SortDir): void {
  if (dir === 'asc') localStorage.setItem(SORT_KEY + section, 'asc');
  else localStorage.removeItem(SORT_KEY + section);
}
