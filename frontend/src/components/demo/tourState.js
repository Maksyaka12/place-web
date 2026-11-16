// The guided tour of the read-only demo: a welcome card, then one step per feature. Each step opens its page,
// highlights one block and says what to try there. Only DemoController mounts it, and only in demo mode.

export const TOUR_STEPS = [
  {
    id: 'explore',
    route: '/',
    targets: ['.pl-campaign-grid', '.pl-place-explore'],
    title: 'Every reward in one place',
    text: 'Live and upcoming campaigns for holders of any token or NFT on Base, from every project. Open a card to see its rules, pool and timeline.',
    hint: 'Open any card',
  },
  {
    id: 'rewards',
    route: '/rewards',
    targets: ['.pl-place-claimable', '.pl-place-rewards'],
    title: 'Claim everything at once',
    text: 'Every campaign this wallet earned, with the amount and a Merkle proof. Press Claim all: instead of a wallet prompt you see the exact transaction that would be sent.',
    hint: 'Try Claim all',
    tryIt: true,
  },
  {
    id: 'create',
    route: '/create',
    targets: ['.pl-place-create-kinds', '.pl-place-create'],
    title: 'Reward any community',
    text: 'Anyone can fund a reward campaign for the holders of a token or an NFT collection, or launch an NFT collection, in one transaction.',
  },
  {
    id: 'agents',
    route: '/agents',
    targets: ['[data-testid="api-playground"]', '.agp-hero'],
    title: 'Agent Zone',
    text: 'AI agents use a public API to see and claim rewards. Run an endpoint to see the live JSON for this wallet.',
    hint: 'Press Run',
  },
];

/* ── Tour state: which step is open (null = closed, -1 = welcome). Shared by the banner and the tour. ── */

const KEY = 'place_demo_tour';
const EVENT = 'place_demo_tour_change';
let current = null;

const readSeen = () => {
  try {
    return sessionStorage.getItem(KEY) === 'seen';
  } catch (e) {
    return false;
  }
};
const markSeen = () => {
  try {
    sessionStorage.setItem(KEY, 'seen');
  } catch (e) {}
};

const emit = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
};

export const getTourStep = () => current;

export function setTourStep(step) {
  current = step;
  if (step !== null) markSeen();
  emit();
}

/** Opens the welcome card the first time the demo starts in this browser session. */
export function openWelcomeOnce() {
  if (current === null && !readSeen()) setTourStep(-1);
}

export const startTour = () => setTourStep(-1);
export const closeTour = () => setTourStep(null);

export function subscribeTour(cb) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}
