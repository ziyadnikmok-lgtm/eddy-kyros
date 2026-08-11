// Deleting a Library picture has to remove it from Eddy's collections too -- and must NOT remove
// anything else. This is a destructive path, so the matcher is tested against the over-delete case
// before the under-delete one: missing a row leaves a broken tile, but deleting the wrong row
// destroys a curated pose or outfit that was never asked about.
const fs = require('fs');
const rd = (f) => fs.readFileSync(f, 'utf8').split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
const casc = rd('D:/Kyros/app/client/src/lib/galleryCascade.js');
const lib = rd('D:/Kyros/app/client/src/pages/LibraryPage.jsx');

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) { pass += 1; console.log('  OK   ' + n); } else { fail += 1; console.log('  FAIL ' + n); } };

// --- the matcher, executed (not grepped) ---------------------------------------------------------
const m = /export function rowMatchesGalleryId\(url, idSet\) \{([\s\S]*?)\n\}/.exec(casc);
const rowMatchesGalleryId = new Function('url', 'idSet', m[1]);
const ids = new Set(['abc', 'x9']);

check('matches the image being deleted', rowMatchesGalleryId('/api/gallery/abc/image', ids));
check('matches with a cache-busting query', rowMatchesGalleryId('/api/gallery/abc/image?r=17', ids));
check('matches a thumb URL too', rowMatchesGalleryId('/api/gallery/abc/thumb', ids));
check('does NOT match a LONGER id that merely starts the same (the over-delete case)',
  !rowMatchesGalleryId('/api/gallery/abc123/image', ids));
check('does NOT match an id that merely ENDS the same', !rowMatchesGalleryId('/api/gallery/zzabc/image', ids));
check('does NOT match the id appearing elsewhere in the path',
  !rowMatchesGalleryId('/api/gallery/other/image?name=abc', ids));
check('does not match a data: URL (a row holding its own bytes is untouched)',
  !rowMatchesGalleryId('data:image/png;base64,abc', ids));
check('an empty/absent url is not a match', !rowMatchesGalleryId('', ids) && !rowMatchesGalleryId(undefined, ids));
check('a second id in the set also matches', rowMatchesGalleryId('/api/gallery/x9/image', ids));

// --- replay the sweep over a realistic mixed collection -------------------------------------------
const rows = [
  { id: 'r1', url: '/api/gallery/abc/image' },          // delete
  { id: 'r2', url: '/api/gallery/abc123/image' },       // KEEP - longer id
  { id: 'r3', url: 'data:image/png;base64,zzz' },       // KEEP - own bytes
  { id: 'r4', url: '/api/gallery/x9/thumb' },           // delete
  { id: 'r5' },                                          // KEEP - no url at all
  { id: 'r6', url: '/api/gallery/x99/image' },          // KEEP - longer id
];
const doomed = rows.filter((r) => rowMatchesGalleryId(r.url, ids)).map((r) => r.id);
check('sweeps exactly the two that point at a deleted image', doomed.join() === 'r1,r4');
check('and leaves the other four alone', rows.length - doomed.length === 4);

// --- wiring ----------------------------------------------------------------------------------------
check('every collection that can hold a gallery URL is listed', (() => {
  const list = /export const CASCADE_COLLECTIONS = \[([\s\S]*?)\];/.exec(casc)[1];
  return ['eddy-library', 'eddy-base', 'eddy-outfit', 'eddy-pose', 'eddy-character']
    .every((c) => list.includes(`'${c}'`));
})());
check('single delete cascades', /await cascadeDeleteFromCollections\(\[deleteTarget\.originalId\]\)/.test(lib));
check('bulk delete cascades', /await cascadeDeleteFromCollections\(imageIds\)/.test(lib));
check('videos do not cascade (they are not in these collections)',
  /if \(deleteTarget\.mediaType === 'image'\) await cascadeDeleteFromCollections/.test(lib));
check('it runs AFTER the server delete, so a cascade failure cannot orphan the file', (() => {
  const srv = lib.indexOf('await galleryApi.remove(deleteTarget.originalId)');
  const cas = lib.indexOf('await cascadeDeleteFromCollections([deleteTarget.originalId])');
  return srv > -1 && cas > srv;
})());
check('one unreadable collection does not abort the rest', /result\.failed\.push\(name\)/.test(casc));
check('the reason it cannot live on the server is written down', /the server cannot see them/.test(casc));

console.log(fail ? `\nFAIL — ${fail}` : `\nPASS — ${pass}/${pass}`);
process.exit(fail ? 1 : 0);
