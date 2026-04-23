This is a digraph visualization tool. It is completely customizable and stores
everything in the URL (gzipped) for easy sharing.

The source code is in `src` dir.

```
src
├── app.js
├── index.html
├── input.css
└── styles.css
```

There are some makefile targets:

```
  install     - npm install dev dependencies
  dev         - run Tailwind --watch + browser-sync live reload (src/)
  build       - produce optimized dist/
  serve       - statically serve dist/ on port 3000
  clean       - remove build artifacts (dist/, src/styles.css)
  distclean   - clean + remove node_modules
  release     - tag & publish a GitHub release (e.g. make release name=v1.2)
```

ALWAYS ask me for authorization before running make release
