/* Verification-lane shim: the macOS sandbox denies Chromium's Mach rendezvous
   (MachPortRendezvousServer bootstrap_check_in → EPERM), so a bare launch exits
   before any page exists. `--single-process --no-zygote` keeps the renderer in
   the browser process and launches. Nothing else is changed. */
import * as real from "/Users/tanyu/.nvm/versions/node/v24.20.0/lib/node_modules/playwright/index.mjs";
const INJECT = ["--single-process", "--no-zygote"];
const chromium = new Proxy(real.chromium, {
  get(target, prop) {
    if (prop === "launch") {
      return (opts = {}) => target.launch({ ...opts, args: [...(opts.args ?? []), ...INJECT] });
    }
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
});
export { chromium };
export default { chromium, chromium_ms: real.chromium };
