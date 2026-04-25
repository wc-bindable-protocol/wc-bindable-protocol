import { PutHttpError, MissingEtagError } from "../retry.js";

/**
 * Run a single XHR PUT attempt and resolve with the response `ETag` header
 * (unquoted — the single-PUT caller strips quotes, the multipart caller
 * re-wraps for the CompleteMultipartUpload XML body).
 *
 * Rejection shapes (inspected by the retry policy):
 *   - `PutHttpError` on any non-2xx — status code carried for retry-policy
 *     classification (5xx / 429 retried, other 4xx terminal).
 *   - `MissingEtagError` on 2xx-with-no-ETag — treated as terminal. The two
 *     realistic causes are bucket CORS missing `ExposeHeaders: ["ETag"]`
 *     and an S3-compatible server that does not emit ETag at all, both of
 *     which are configuration issues that will not self-heal.
 *   - Plain `Error("network error during PUT.")` on transport failure —
 *     retriable (defaultPutRetryPolicy) unless the caller has already set
 *     its abort flag.
 *   - Plain `Error("upload aborted.")` on explicit XHR abort — the retry
 *     loop polls its `isAborted` callback and bails without retrying.
 *
 * `xhrs` is the live Set the Shell uses to cancel in-flight XHRs via
 * `_cancelXhrs()`. Registering against a shared Set keeps the Shell's
 * abort-all-XHRs semantics intact without exposing the Set as a singleton:
 * each `S3` instance has its own Set, each XHR is added on creation and
 * removed on terminal callback (load/error/abort), and the Shell can reach
 * in to `.abort()` every entry when its own `abort()` fires.
 *
 * Extracted from `S3.ts` (C7-#2) so the ~80-line PUT-XHR plumbing does not
 * sit on top of the already-large element class. No behaviour change.
 */
export function doPutOnce(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Blob,
  xhrs: Set<XMLHttpRequest>,
  onProgress?: (loaded: number, total: number) => void,
  onLoad?: () => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // `xhr.open()` and `setRequestHeader()` can synchronously throw:
    // `open` on malformed URLs / disallowed methods, `setRequestHeader` on
    // forbidden header names (`Host`, `Cookie`, etc. per Fetch spec §5). If
    // either throws AFTER we have added the xhr to the shared `xhrs` Set,
    // the Promise executor re-throw is converted to a reject — but the Set
    // still carries a never-fired entry that `_cancelXhrs()` would later
    // `.abort()` (benign, but misleading, and the Set grows monotonically
    // under repeated failures). Register the xhr only once the handshake
    // prep has succeeded so the Set's invariant ("every entry is a live,
    // send()-pending XHR") survives host-synchronous throws too. Mirrors
    // the `xhr.send()` try/catch below: both entry points are guarded by
    // the same "register only on success" / "unregister on failure" rule.
    try {
      xhr.open(method, url, true);
      for (const [name, value] of Object.entries(headers)) {
        xhr.setRequestHeader(name, value);
      }
    } catch (e: unknown) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    xhrs.add(xhr);
    if (onProgress) {
      xhr.upload.addEventListener("progress", (ev: ProgressEvent) => {
        if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
      });
    }
    xhr.addEventListener("load", () => {
      xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) {
          // 2xx with no ETag is a silent-data-corruption trap: we would
          // resolve with "" and let `_complete()` / `completeMultipart()`
          // stamp an empty etag into the post-process context and the
          // download presign. The two realistic causes — missing
          // `ExposeHeaders: ["ETag"]` on the bucket CORS, and an
          // S3-compatible server that does not emit ETag at all — are
          // both configuration issues that will not self-heal, so the
          // retry policy also classifies this as non-retriable.
          reject(new MissingEtagError(
            `[@wc-bindable/s3] PUT succeeded (${xhr.status}) but response has no ETag header. Check bucket CORS 'ExposeHeaders: [\"ETag\"]' or verify the S3-compatible server emits ETag.`
          ));
          return;
        }
        if (onLoad) onLoad();
        resolve(etag);
      } else {
        reject(new PutHttpError(
          `[@wc-bindable/s3] PUT failed (${xhr.status}).`,
          xhr.status,
          xhr.responseText || xhr.statusText || "",
        ));
      }
    });
    xhr.addEventListener("error", () => {
      xhrs.delete(xhr);
      reject(new Error("[@wc-bindable/s3] network error during PUT."));
    });
    xhr.addEventListener("abort", () => {
      xhrs.delete(xhr);
      // Marked non-retriable by the retry policy via the abort signal check
      // — defaultPutRetryPolicy still returns true for plain Errors, but
      // retryWithBackoff polls isAborted() before sleeping and after waking,
      // so the loop bails out without another attempt.
      reject(new Error("[@wc-bindable/s3] upload aborted."));
    });
    // `xhr.send()` can synchronously throw: invalid state if another request
    // is already in flight on this xhr, `SecurityError` on disallowed
    // cross-origin/header combinations, and host-specific errors in some
    // embedded environments. Without this try/catch, the throw would bubble
    // out of the Promise constructor to the caller — but by that time `xhr`
    // is already registered in `xhrs`, so the Set leaks a never-fired entry.
    // `cancelXhrs()` would then try to `.abort()` a send-that-never-started
    // XHR on the next user abort, which is benign but misleading, and the
    // Set grows monotonically under repeated failures. Remove from the Set
    // and reject the promise symmetrically with the error / abort listeners.
    try {
      xhr.send(body);
    } catch (e: unknown) {
      xhrs.delete(xhr);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Abort every XHR registered in the live Set and clear it. The try/catch
 * guards against XHRs already in a terminal state (their `.abort()` is a
 * no-op but can throw on some hosts). Centralised here so the Shell does
 * not carry the loop body alongside the rest of its upload plumbing.
 */
export function cancelXhrs(xhrs: Set<XMLHttpRequest>): void {
  for (const xhr of xhrs) {
    try { xhr.abort(); } catch { /* already done */ }
  }
  xhrs.clear();
}
