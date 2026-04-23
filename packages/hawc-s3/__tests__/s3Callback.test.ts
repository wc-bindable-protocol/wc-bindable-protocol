import { describe, it, expect, beforeAll, vi } from "vitest";
import { S3 } from "../src/components/S3";
import { S3Callback } from "../src/components/S3Callback";
import { setConfig } from "../src/config";

// Register the host element under TWO tag names: the default hawc-s3 (so other
// suites are unaffected) and a custom one that exercises tagNames overrides.
const CUSTOM_HOST = "custom-s3-host";

beforeAll(() => {
  if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
  if (!customElements.get("hawc-s3-callback")) customElements.define("hawc-s3-callback", S3Callback);
  if (!customElements.get(CUSTOM_HOST)) customElements.define(CUSTOM_HOST, class extends S3 {});
});

describe("S3Callback host lookup respects config.tagNames", () => {
  it("default tag name: callback finds the ancestor <hawc-s3>", async () => {
    setConfig({ tagNames: { s3: "hawc-s3", s3Callback: "hawc-s3-callback" } });
    const host = document.createElement("hawc-s3");
    host.setAttribute("bucket", "b");
    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    host.appendChild(cb);
    document.body.appendChild(host);

    // _findHost is private; assert via behavior — calling the (private) method
    // through a cast is fine because the alternative is fragile DOM mutation
    // observation.
    const found = (cb as any)._findHost();
    expect(found).toBe(host);

    document.body.removeChild(host);
  });

  it("custom tag name: callback walks up to a renamed host element", async () => {
    setConfig({ tagNames: { s3: CUSTOM_HOST, s3Callback: "hawc-s3-callback" } });
    const host = document.createElement(CUSTOM_HOST);
    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    host.appendChild(cb);
    document.body.appendChild(host);

    const found = (cb as any)._findHost();
    expect(found).toBe(host);

    document.body.removeChild(host);
    // Reset for other suites in the same process.
    setConfig({ tagNames: { s3: "hawc-s3", s3Callback: "hawc-s3-callback" } });
  });

  it("custom tag name: callback does NOT spuriously match the default tag", async () => {
    // After setConfig switches to a custom host tag, a leftover <hawc-s3>
    // ancestor must not be picked up — the contract is "configured tag only."
    setConfig({ tagNames: { s3: CUSTOM_HOST, s3Callback: "hawc-s3-callback" } });
    const wrongHost = document.createElement("hawc-s3");
    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    wrongHost.appendChild(cb);
    document.body.appendChild(wrongHost);

    const found = (cb as any)._findHost();
    expect(found).toBe(null);

    document.body.removeChild(wrongHost);
    setConfig({ tagNames: { s3: "hawc-s3", s3Callback: "hawc-s3-callback" } });
  });

  it("`for` selector still works regardless of tagNames config", async () => {
    setConfig({ tagNames: { s3: CUSTOM_HOST, s3Callback: "hawc-s3-callback" } });
    const host = document.createElement("hawc-s3"); // intentionally NOT the configured tag
    host.id = "explicit-target";
    document.body.appendChild(host);
    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.setAttribute("for", "#explicit-target");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    document.body.appendChild(cb); // outside the host tree on purpose

    const found = (cb as any)._findHost();
    expect(found).toBe(host);

    document.body.removeChild(host);
    document.body.removeChild(cb);
    setConfig({ tagNames: { s3: "hawc-s3", s3Callback: "hawc-s3-callback" } });
  });
});

describe("S3Callback async-attach race", () => {
  // _loadModule() runs asynchronously in connectedCallback. If the callback
  // element is removed before the load resolves, the deferred `.then(_attach)`
  // would otherwise still run and register a listener on the (still-live)
  // host. The detached callback then leaks — its disconnectedCallback already
  // ran, so the listener has no clean-up path.

  beforeAll(() => {
    if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
    if (!customElements.get("hawc-s3-callback")) customElements.define("hawc-s3-callback", S3Callback);
  });

  it("connect-then-immediately-disconnect does NOT register a listener on the host", async () => {
    const host = document.createElement("hawc-s3");
    host.id = "leak-host";
    document.body.appendChild(host);

    // Spy on addEventListener so we can detect the leak directly. Native
    // host.addEventListener is what _attach() calls — anything attached
    // through it would survive the callback element going off-DOM.
    const addSpy = vi.spyOn(host, "addEventListener");

    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.setAttribute("for", "#leak-host");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    document.body.appendChild(cb);

    // Remove the callback element immediately — before the queued microtask
    // and Blob-URL dynamic import have a chance to resolve.
    document.body.removeChild(cb);

    // Drain microtasks AND let any pending dynamic import settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 10));

    // The bug: addEventListener was called even though cb is detached.
    // Filter to event names we care about; any framework code might attach
    // unrelated internal listeners on the host element itself.
    const callbackEventCalls = addSpy.mock.calls.filter(
      ([name]) => typeof name === "string" && name.startsWith("hawc-s3:"),
    );
    expect(callbackEventCalls).toEqual([]);

    addSpy.mockRestore();
    document.body.removeChild(host);
  });

  it("attaches normally when the element stays connected", async () => {
    // Sanity: the guard does not break the happy path.
    const host = document.createElement("hawc-s3");
    host.id = "happy-host";
    document.body.appendChild(host);
    const addSpy = vi.spyOn(host, "addEventListener");

    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.setAttribute("for", "#happy-host");
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    document.body.appendChild(cb);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 10));

    const callbackEventCalls = addSpy.mock.calls.filter(
      ([name]) => typeof name === "string" && name === "hawc-s3:completed-changed",
    );
    expect(callbackEventCalls).toHaveLength(1);

    addSpy.mockRestore();
    document.body.removeChild(cb);
    document.body.removeChild(host);
  });
});

describe("S3Callback resource-leak on async _loadModule race", () => {
  // The host-listener leak is fixed by the guard in _attach(), but
  // _loadModule itself runs after disconnect can still allocate a Blob URL,
  // dynamic-import a module, and store the resulting function on a detached
  // element. disconnectedCallback fires only once — anything created after
  // it has no clean-up path and accumulates across rapid mount/unmount loops.

  beforeAll(() => {
    if (!customElements.get("hawc-s3")) customElements.define("hawc-s3", S3);
    if (!customElements.get("hawc-s3-callback")) customElements.define("hawc-s3-callback", S3Callback);
  });

  function makeCallback(hostId: string): HTMLElement {
    const cb = document.createElement("hawc-s3-callback");
    cb.setAttribute("on", "completed");
    cb.setAttribute("for", `#${hostId}`);
    cb.innerHTML = `<script type="module">export default () => {}</script>`;
    return cb;
  }

  it("connect→immediately-disconnect does NOT call URL.createObjectURL or set _fn", async () => {
    const host = document.createElement("hawc-s3");
    host.id = "leak-host-2";
    document.body.appendChild(host);

    const createSpy = vi.spyOn(URL, "createObjectURL");

    const cb = makeCallback("leak-host-2");
    document.body.appendChild(cb);
    document.body.removeChild(cb);

    // Drain microtasks (_loadModule starts), then a few macro ticks for the
    // dynamic-import resolution that would race in the buggy code.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 10));

    expect(createSpy, "no Blob URL should have been allocated for a detached callback").not.toHaveBeenCalled();
    expect((cb as any)._fn, "_fn must remain null after disconnect").toBeNull();
    expect((cb as any)._blobUrl, "_blobUrl must remain null after disconnect").toBeNull();

    createSpy.mockRestore();
    document.body.removeChild(host);
  });

  it("rapid mount/unmount loop does not accumulate Blob URLs", async () => {
    const host = document.createElement("hawc-s3");
    host.id = "rapid-host";
    document.body.appendChild(host);

    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");

    // 20 rapid mount/unmount cycles with no microtask drain in between —
    // mirrors a framework that mounts and unmounts a route component
    // quickly during navigation.
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i++) {
      const cb = makeCallback("rapid-host");
      document.body.appendChild(cb);
      document.body.removeChild(cb);
    }

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 20));

    // Pre-fix: createObjectURL was called once per iteration (each
    // microtask reached the Blob allocation before the disconnect-check
    // would have stopped it). Post-fix: the early bail prevents allocation.
    expect(createSpy.mock.calls.length, "no Blob URLs should be allocated when every cycle disconnects before the microtask").toBe(0);
    // Defensive: even if a future change re-enables allocation in some
    // reachable path, the invariant we care about is "every alloc is
    // matched by a revoke" so the count of in-flight Blob URLs stays bounded.
    expect(revokeSpy.mock.calls.length).toBe(createSpy.mock.calls.length);

    createSpy.mockRestore();
    revokeSpy.mockRestore();
    document.body.removeChild(host);
  });

  it("a load that runs while connected, then disconnects, does not leak a Blob URL", async () => {
    // Pairs every createObjectURL with a revokeObjectURL over the element's
    // lifetime. We do not pin WHERE the revoke happens (success vs failure
    // of the dynamic import, or on disconnect) — happy-dom's blob-URL import
    // is unreliable. All we assert is the accounting invariant: counts match,
    // and `_blobUrl` is null by the time the element is off-DOM.
    const host = document.createElement("hawc-s3");
    host.id = "normal-host";
    document.body.appendChild(host);
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");

    const cb = makeCallback("normal-host");
    document.body.appendChild(cb);
    // Let the load reach the Blob allocation (synchronous part of _loadModule).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 10));
    expect(createSpy).toHaveBeenCalledTimes(1);

    document.body.removeChild(cb);
    // All allocations accounted for by a revoke: the module-load catch path
    // revokes on failure (C7-#5), and disconnectedCallback revokes any still-
    // attached blob. Either way, counts balance and the slot is clear.
    expect(revokeSpy.mock.calls.length).toBe(createSpy.mock.calls.length);
    expect((cb as any)._blobUrl).toBeNull();

    createSpy.mockRestore();
    revokeSpy.mockRestore();
    document.body.removeChild(host);
  });

  it("stale _loadModule does not revoke a newer generation's blob URL", async () => {
    // Regression pin: an earlier revision had gen=1 reach its stale-cleanup
    // path and call this._revokeBlob() — which reads this._blobUrl. If
    // gen=2 had already allocated and assigned its newer blob to
    // this._blobUrl, the stale cleanup would revoke the LIVE blob and the
    // newer generation would dynamic-import a revoked URL.
    //
    // Post-fix: each _loadModule invocation captures its own blob URL
    // locally and only revokes that specific URL from the stale path.
    //
    // Under C7-#5 the failure path of gen=1 may revoke its own blob as soon
    // as the import rejects (happy-dom's dynamic-import of blob URLs is not
    // reliable), so we no longer assert that `_blobUrl` holds gen=1's value
    // at the time we swap `src`. The invariant we still enforce: whatever
    // URL is LIVE on `_blobUrl` at the end must not appear in the revoke
    // spy after it was assigned.
    const host = document.createElement("hawc-s3");
    host.id = "stale-race-host";
    document.body.appendChild(host);
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");

    const cb = makeCallback("stale-race-host");
    document.body.appendChild(cb);
    // Let gen=1 reach the Blob allocation.
    await new Promise((r) => setTimeout(r, 0));

    // Trigger gen=2 by swapping the src attribute. Note: attributeChangedCallback
    // re-runs _loadModule which calls _revokeBlob() at the top — that revokes
    // any gen=1 blob still attached before allocating gen=2's own blob.
    cb.setAttribute("src", "data:application/javascript,export default () => {}");
    // Allow any pending microtasks/macrotasks to drain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 20));

    // The element's current blob slot (if any) must never have been
    // revoked AFTER it was assigned. We accept that blobs from earlier
    // generations may be revoked any number of times (idempotent), but
    // the currently-attached blob must either be null (src took over)
    // or be absent from the revoke-spy call list.
    const current = (cb as any)._blobUrl as string | null;
    if (current !== null) {
      const revokedUrls = revokeSpy.mock.calls.map(([u]) => u);
      expect(revokedUrls).not.toContain(current);
    }

    revokeSpy.mockRestore();
    document.body.removeChild(cb);
    document.body.removeChild(host);
  });
});
