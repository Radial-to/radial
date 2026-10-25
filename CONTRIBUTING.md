# Contributing

Thanks for wanting to help with Radial for Mac.

## Issues, not pull requests

For now we take issues only. Report bugs and share ideas in [issues](https://github.com/Radial-to/radial/issues/new/choose); pull requests are turned off. A clear issue with the steps to reproduce helps us most.

Security problems go to [SECURITY.md](SECURITY.md), not to public issues.

## Build and test

You need a Mac with Apple silicon, Node 20 or newer and the Xcode command line tools.

```sh
npm ci
npm start           # run the app from the source
npm test            # unit tests
npm run test:e2e    # end-to-end tests that drive the app
```

Some end-to-end tests work on a real site on your Mac and skip when it isn't there. `npm run pack` makes an unsigned app, and `npm run test:smoke` checks it.

## Where things are

- `src/main`: the app's main process: projects, agents, dev servers and publishing.
- `src/renderer`: the app's interface.
- `src/preload`: the bridge between the two.
- `bin/radial`: the `radial` command-line tool.
- `samples/static-site`: a small site to try things on.
- `test`: unit and end-to-end tests.
- `docs/design` and `DESIGN.md`: how the interface is designed.

Icons are generated into `src/renderer/icons.gen.js` by `npm run icons`, so don't edit that file by hand.
