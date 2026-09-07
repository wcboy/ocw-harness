import { useEffect } from 'react';
declare const __OCW_UI__: {sourceDigest: string; designVersion: string};
export function useCurrentUi() {
  useEffect(() => {
    let stopped = false, pending = false;
    let controller: AbortController | null = null;
    async function check() {
      if (pending) return;
      pending = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 3000);
      try {
        const response = await fetch('/ui-build.json', {cache:'no-store', signal:controller.signal});
        if (!response.ok) return;
        const build = await response.json();
        if (!stopped && build.designVersion && typeof build.sourceDigest === 'string' && build.sourceDigest !== __OCW_UI__.sourceDigest) {
          // A manifest can arrive before the index or the restarted adapter.
          // Keep the working page until the server validates the complete build.
          const ready = await fetch('/index.html', {method:'HEAD',cache:'no-store',signal:controller.signal});
          if (!ready.ok || stopped) return;
          // Per-version guard prevents an inconsistent deployment/reverse proxy
          // from reloading forever. Selection and harness remain in the URL.
          const key='ocw-ui-reloaded:' + build.sourceDigest;
          if (!sessionStorage.getItem(key)) {sessionStorage.setItem(key,'1'); window.location.reload();}
        }
      } catch { /* The read-only stream already reports connection failures. */ }
      finally { window.clearTimeout(timeout); pending=false; }
    }
    void check(); const timer=window.setInterval(check,5000);
    return () => {stopped=true;controller?.abort();window.clearInterval(timer);};
  }, []);
}
