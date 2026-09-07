// Non-secret front-end config. The Firebase project config lives in
// ../firebase-config.js. This only carries the Google Places key used for
// address autocomplete (Phase 3). Restrict it to the gameplan hosting domain
// in the Google Cloud console.
window.GAMEPLAN_CONFIG = {
  environment: "firebase-preview",
  placesApiKey: "AIzaSyBNLnFQ_z9rfOiWeFzqqm4kus6S9iwoTZ0",
};
