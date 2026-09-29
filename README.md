# unfollowtool-export-parsers

[![test](https://github.com/RobinOehler/unfollowtool-export-parsers/actions/workflows/test.yml/badge.svg)](https://github.com/RobinOehler/unfollowtool-export-parsers/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Parsers for the **official data exports** of Instagram, TikTok, X (Twitter) and Facebook. They turn the ZIP a platform gives you into clean follower / following lists — in the browser or in Node, with **no login, no API and no upload**.

These are the parsers behind [UnfollowTool](https://www.unfollowtool.com/), a free tool that shows who doesn't follow you back and who unfollowed you. They are published so anyone can check what the site does with an export, and reuse the format knowledge.

- **Private by design:** pure functions over the files you pass in. No network, no storage, no DOM.
- **Real-world formats:** every export generation we've seen, JSON and HTML, localized labels, numbered parts, re-zipped copies, BOMs, Meta's mojibake encoding.
- **Safe output:** profile URLs are rebuilt from validated usernames/IDs only, never copied from the file.
- **Fast:** 100k following / 60k followers parse in well under 1.5 s.
- **Tested:** ~250 unit tests against generated fixtures that mirror real exports.

## Supported exports

| Platform | Export | Formats and variants |
|---|---|---|
| Instagram | Accounts Center → Export your information → Followers and following | JSON (2022+ `connections/followers_and_following/followers_1.json …`, `following.json`; 2024+ `title`-only entries; 2025+ `label_values` records), legacy 2021 `followers.json`, ≤2020 `connections.json`, HTML (localized dates). Optional lists: pending requests, recently unfollowed, received requests, close friends, blocked, restricted, removed suggestions. |
| TikTok | Settings → Download your data | JSON (`user_data_tiktok.json`, 2020–2025 section layouts) and TXT (`Follower.txt` / `Following.txt`, localized labels, UTF-16). |
| X (Twitter) | Settings → Download an archive of your data | `data/follower.js`, `data/following.js` (+ `-partN`), `manifest.js`, `account.js`. X exports account IDs only. |
| Facebook | Download your information → Connections | JSON and HTML, 2018–2025 layouts: friends, followers, following, sent/received/removed requests. Facebook exports display names only. |

Details for each variant are in the header comment of the parser in `src/parsers/`.

## Usage

### Browser

```html
<script src="src/ut-core.js"></script>
<script src="src/ut-files.js"></script>          <!-- ZIP/FileList reader -->
<script src="src/parsers/instagram.js"></script>
<script>
  input.addEventListener('change', async () => {
    const files = await UT.files.fromFileList(input.files);  // reads the ZIP locally
    const parser = UT.parsers.instagram;
    const result = await parser.parse(files);
    const views = parser.views(result);                      // e.g. notFollowingBack, fans, mutual
    console.log(views.find((v) => v.primary).entries);
  });
</script>
```

`ut-files.js` reads ZIPs natively with `Blob.slice()` + `DecompressionStream`, so multi-GB exports (ZIP64, with media) work and only the needed entries are inflated. Browsers without `DecompressionStream('deflate-raw')` fall back to JSZip (`vendor/jszip.min.js` next to the script, max. 2 GB).

### Node

The parsers only need a *FileSet*: a list of paths and a `read(path)` function. Build one from a ZIP, for example with JSZip:

```js
const fs = require('fs');
const JSZip = require('jszip');
const instagram = require('./src/parsers/instagram.js');

async function fileSetFromZip(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir && !p.startsWith('__MACOSX/'));
  return {
    paths,
    sourceNames: [file],
    read: (p) => zip.file(p).async('string').then((s) => s.replace(/^﻿/, '')),
    has: (re) => paths.filter((p) => re.test(p)),
  };
}

(async () => {
  const set = await fileSetFromZip('instagram-export.zip');
  if (instagram.detect(set.paths) < 0.5) throw new Error('not an Instagram export');
  const result = await instagram.parse(set);
  for (const view of instagram.views(result)) console.log(view.id, view.entries.length);
})();
```

## Parser contract

Every parser exports the same object:

```js
{
  id: 'instagram' | 'tiktok' | 'x' | 'facebook',
  detect(paths)   → number 0..1   // how likely these file paths are this platform's export
  parse(fileSet)  → Promise<Result>
  views(result)   → View[]
}

Entry  = { key, username, name, url, ts }   // key: stable lowercase username or id; url: validated https profile URL or null; ts: ms epoch or null
Result = { platform, lists: { followers?, following?, friends?, …extra }, files, warnings: [{ code, params }], owner }
View   = { id, entries, primary?, dateKey? }  // e.g. notFollowingBack (primary), fans, mutual, pendingRequests …
```

**Errors** are thrown with a stable `code` (and `params`): `NO_RELEVANT_FILES`, `WRONG_PLATFORM {platform}`, `MISSING_LIST {list}`, `CORRUPT_FILE {file}`, `HTML_EXPORT_UNSUPPORTED` (Facebook HTML without usable lists), `EMPTY_LISTS`. With `ut-core.js` loaded they are `UT.UTError` instances, otherwise plain `Error`s with the same `code`/`params`.

**Security:** entry text is plain data (never HTML). URLs are only built as `https://<platform host>/<validated username or id>`; anything else gets `url: null`. `ut-core.js` also contains the CSV writer used by the site (RFC 4180, spreadsheet-formula neutralisation).

## Tests

```bash
npm install
npm test          # generates the fixture ZIPs, then runs node --test
```

Fixtures are generated by `tests/fixtures/<platform>/generate.js` and mirror the structure of real exports; `expected.json` holds the expected outcome of each one. No real user data is included.

## Contributing

A new export layout, a language whose labels aren't recognised, or a file the parser rejects? Open an issue with the **folder structure and a few anonymized lines** (replace usernames), never the export itself.

## License

MIT © Robin Oehler — made for [UnfollowTool](https://www.unfollowtool.com/) · [About](https://www.unfollowtool.com/about.html)
