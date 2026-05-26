# @archastro/redline

## 0.1.1

### Patch Changes

- Restrict the Chrome extension content script to localhost / 127.0.0.1 / \*.localhost (http + https) instead of injecting on every page. Add more match patterns to `extension/manifest.json` if you need it on staging or prod hosts.
