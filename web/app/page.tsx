"use client";

import { useEffect, useState } from "react";
import { CreateForm } from "@/components/CreateForm";
import { LiveSession } from "@/components/LiveSession";
import { loadSession } from "@/lib/storage";

type Mode =
  | { kind: "loading" }
  | { kind: "create" }
  | { kind: "session"; sessionId: string; token: string; shareUrl?: string };

// cocode is exported as static HTML (next.config.js: output "export"), so
// there is no dynamic /s/[id] route — instead this single page decides its
// role from the URL query string (spec §3's routing note, §5.1, §10-2).
// The bare URL (no query string) is only ever the "pick a meeting point"
// screen; both A and B always view live sharing at a `?s=<id>&t=<token>`
// URL — A's own token forms a personal URL distinct from the invite link
// (which carries B's token). A session resumed from localStorage rewrites
// the address bar to that URL via replaceState so what's shown always
// matches what's in the URL.
function sessionUrl(sessionId: string, token: string): string {
  return `/?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`;
}

export default function Page() {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("s");
    const t = params.get("t");
    const stored = loadSession();

    if (s && t) {
      // The invite link (B's token) never appears in localStorage, so this
      // only recovers anything for A reloading on the same device — but
      // that's the case that matters: A's own shareUrl otherwise has no
      // other source once it's off the create-session response.
      const shareUrl = stored && stored.sessionId === s ? stored.shareUrl : undefined;
      setMode({ kind: "session", sessionId: s, token: t, shareUrl });
      return;
    }

    if (stored) {
      window.history.replaceState(null, "", sessionUrl(stored.sessionId, stored.token));
      setMode({
        kind: "session",
        sessionId: stored.sessionId,
        token: stored.token,
        shareUrl: stored.shareUrl,
      });
      return;
    }

    setMode({ kind: "create" });
  }, []);

  if (mode.kind === "loading") {
    return <div className="cocode-center-shell">読み込み中…</div>;
  }

  if (mode.kind === "create") {
    return (
      <CreateForm
        onCreated={(sessionId, token, shareUrl) => {
          window.history.replaceState(null, "", sessionUrl(sessionId, token));
          setMode({ kind: "session", sessionId, token, shareUrl });
        }}
      />
    );
  }

  return <LiveSession sessionId={mode.sessionId} token={mode.token} shareUrl={mode.shareUrl} />;
}
