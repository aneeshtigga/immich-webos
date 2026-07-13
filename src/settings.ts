// Small persisted UI preferences. webOS web apps have a normal localStorage
// that survives app restarts (same store the auth state uses).

const LIVE_PLAY_KEY = 'immich.livePlay';
const VIDEO_QUALITY_KEY = 'immich.videoQuality';

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
