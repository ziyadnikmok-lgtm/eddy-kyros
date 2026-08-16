/**
 * Photo Match NB2 — the same page, pointed at Nano Banana 2 on Google's own API.
 *
 * Three lines rather than a copied file, and that is the whole point. Photo Match is the twins
 * cast, the back-view detection, the pose/mood/lighting chips, the blur pipeline, the library
 * destinations and a prompt builder tuned over months against real failures. A duplicate would mean
 * every one of those fixed twice from now on, and the two copies quietly disagreeing about which is
 * right — which is how a page ends up with a bug that was already fixed next door.
 *
 * A separate module rather than a prop passed at the nav layer so it can still be lazy-loaded by
 * id, exactly like every other page in App.jsx.
 */
import PhotoMatchSeedreamPage from './PhotoMatchSeedreamPage';

export default function PhotoMatchNB2Page() {
  return <PhotoMatchSeedreamPage variant="nb2" />;
}
